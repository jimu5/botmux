/**
 * Federation HUB endpoints. Cross-deployment, so mounted BEFORE the dashboard's
 * `?t=` token gate (like webhook/team routes) — they authenticate by their OWN
 * credentials instead:
 *   - POST /api/federation/join   → an invite code (single-use admission)
 *   - POST /api/federation/sync   → a syncToken (per-deployment bearer)
 *   - GET  /api/federation/roster → a syncToken
 *
 * A spoke deployment registers once with an invite, gets a long-lived syncToken,
 * then pushes bots + pulls the aggregated roster with it. See docs/federation-design.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { jsonRes } from './workflow-api.js';
import { consumeInvite } from '../services/invite-store.js';
import { getTeam } from '../services/team-store.js';
import {
  registerDeployment, syncDeployment, getDeploymentByToken, removeDeploymentByToken,
  type FederatedBot,
} from '../services/federation-store.js';
import { buildFederatedRoster } from '../services/federation-roster.js';
import { findMembershipByDelegationToken } from '../services/federation-membership-store.js';

const MAX_BOTS = 200;

/** Federation bearer token: prefer the header (keeps the long-lived syncToken out
 *  of URLs / access logs); fall back to ?syncToken= for short-term hub compat. */
function federationToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-botmux-federation-token'];
  if (typeof x === 'string' && x) return x.trim();
  return (url.searchParams.get('syncToken') ?? '').trim();
}

async function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/** Defensive: only keep the fields we expect, cap the count, coerce types. */
function sanitizeBots(input: unknown): FederatedBot[] {
  if (!Array.isArray(input)) return [];
  const out: FederatedBot[] = [];
  for (const raw of input.slice(0, MAX_BOTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.larkAppId !== 'string' || !r.larkAppId) continue;
    out.push({
      larkAppId: r.larkAppId,
      botName: typeof r.botName === 'string' ? r.botName : r.larkAppId,
      cliId: typeof r.cliId === 'string' ? r.cliId : '',
      botUnionId: typeof r.botUnionId === 'string' ? r.botUnionId : undefined,
      capability: typeof r.capability === 'string' ? r.capability : null,
      hasTeamRole: !!r.hasTeamRole,
      ownerUnionId: typeof r.ownerUnionId === 'string' ? r.ownerUnionId : undefined,
      ownerName: typeof r.ownerName === 'string' ? r.ownerName : undefined,
    });
  }
  return out;
}

export interface FederationApiDeps {
  dataDir?: string;
  /** Injected by dashboard.ts — used when a HUB delegates 拉群 to THIS spoke
   *  (we create the chat with one of OUR local online bots as creator). */
  createTeamGroup?: (args: { name: string; larkAppIds: string[]; ownerUnionIds?: string[] }) => Promise<{
    ok: boolean; chatId?: string; shareLink?: string; invalidBotIds?: string[]; invalidOwnerUnionIds?: string[]; error?: string;
  }>;
}

export async function handleFederationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FederationApiDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/federation/')) return false;
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const method = req.method ?? 'GET';

  // Spoke registers via an invite → issued a syncToken bound to the team.
  if (path === '/api/federation/join' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const inviteCode = String(body?.inviteCode ?? '').trim();
    const dep = body?.deployment;
    if (!inviteCode) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    if (!dep || typeof dep.deploymentId !== 'string' || !dep.deploymentId) {
      jsonRes(res, 400, { ok: false, error: 'deployment_required' }); return true;
    }
    const inv = consumeInvite(dataDir, inviteCode);
    if (!inv.ok) { jsonRes(res, 403, { ok: false, error: `invite_${inv.reason}` }); return true; }
    const team = getTeam(dataDir, inv.teamId);
    if (!team) { jsonRes(res, 403, { ok: false, error: 'invite_team_deleted' }); return true; }
    const reg = registerDeployment(dataDir, inv.teamId, {
      deploymentId: dep.deploymentId,
      name: typeof dep.name === 'string' && dep.name ? dep.name : dep.deploymentId,
      bots: sanitizeBots(dep.bots),
      callbackUrl: typeof dep.callbackUrl === 'string' && /^https?:\/\//i.test(dep.callbackUrl) ? dep.callbackUrl.replace(/\/+$/, '') : undefined,
      delegationToken: typeof dep.delegationToken === 'string' ? dep.delegationToken : undefined,
    });
    // deploymentId is public (shows in roster) — never hand back an existing
    // deployment's long-lived token. A duplicate must re-bind via an explicit
    // reset proving the old token (future), not by re-joining with an invite.
    if (!reg.created) { jsonRes(res, 409, { ok: false, error: 'deployment_already_joined' }); return true; }
    jsonRes(res, 200, { ok: true, teamId: inv.teamId, teamName: team.name, syncToken: reg.syncToken });
    return true;
  }

  // Spoke-initiated leave/revoke: drop this deployment from its team (authed by
  // its own syncToken). Idempotent — unknown token is treated as already gone.
  if (path === '/api/federation/leave' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const syncToken = String(body?.syncToken ?? '').trim() || federationToken(req, url);
    if (!syncToken) { jsonRes(res, 401, { ok: false, error: 'token_required' }); return true; }
    removeDeploymentByToken(dataDir, syncToken);
    jsonRes(res, 200, { ok: true });
    return true;
  }

  // Spoke pushes its current bots + heartbeat.
  if (path === '/api/federation/sync' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const syncToken = String(body?.syncToken ?? '').trim();
    if (!syncToken) { jsonRes(res, 401, { ok: false, error: 'token_required' }); return true; }
    const ok = syncDeployment(dataDir, syncToken, sanitizeBots(body?.bots));
    if (!ok) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    jsonRes(res, 200, { ok: true });
    return true;
  }

  // Spoke pulls the aggregated cross-deployment roster for its team.
  if (path === '/api/federation/roster' && method === 'GET') {
    const found = getDeploymentByToken(dataDir, federationToken(req, url));
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    jsonRes(res, 200, { ok: true, ...buildFederatedRoster(dataDir, found.teamId) });
    return true;
  }

  // Hub delegates 拉群 to THIS spoke (hub→spoke): the hub had no local online
  // creator, so it asks the deployment that owns a selected bot to create the
  // group with ITS own online bot. Authed by the delegationToken THIS spoke
  // issued to that hub at join (team-internal trust).
  if (path === '/api/federation/delegate-group' && method === 'POST') {
    if (!deps.createTeamGroup) { jsonRes(res, 501, { ok: false, error: 'group_create_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const token = federationToken(req, url) || String(body?.delegationToken ?? '').trim();
    if (!findMembershipByDelegationToken(dataDir, token)) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const larkAppIds: string[] = Array.isArray(body?.larkAppIds) ? body.larkAppIds.filter((x: any) => typeof x === 'string') : [];
    const ownerUnionIds: string[] = Array.isArray(body?.ownerUnionIds) ? body.ownerUnionIds.filter((x: any) => typeof x === 'string') : [];
    const name = (String(body?.name ?? '').trim()) || '协作群';
    if (larkAppIds.length === 0) { jsonRes(res, 400, { ok: false, error: 'no_bots_selected' }); return true; }
    const r = await deps.createTeamGroup({ name, larkAppIds, ownerUnionIds });
    jsonRes(res, r.ok ? 200 : 502, r);
    return true;
  }

  jsonRes(res, 404, { ok: false, error: 'not_found' });
  return true;
}
