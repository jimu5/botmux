/**
 * Team platform routes: pairing-login + authenticated team read APIs.
 *
 * Mounted BEFORE the personal-dashboard shared-token gate (like the webhook
 * route), because the team platform is a SEPARATE surface with its OWN auth:
 * a per-user Feishu identity → `bmx_session` cookie (via pairing-login). The
 * personal dashboard's `?t=` token gate is left untouched.
 *
 * Returns true if it handled the request, false to let the dashboard continue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { jsonRes } from './workflow-api.js';
import { pairingStart, pairingStatusView, pairingConsume, PAIR_COOKIE, SESSION_COOKIE } from './pairing-api.js';
import { getWebSession, revokeWebSession, type WebSession } from '../services/web-session-store.js';
import { buildTeamRoster } from '../services/team-roster.js';
import { listConnectors } from '../services/connector-store.js';
import { listTriggerLogs, summarizeTriggerLogs, type TriggerLogListOptions } from '../services/trigger-log-store.js';

export interface TeamRouteDeps {
  dataDir?: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookieHeader(res: ServerResponse, name: string, value: string, maxAgeMs: number): void {
  const maxAge = Math.floor(maxAgeMs / 1000);
  const attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  const existing = res.getHeader('set-cookie');
  const cookie = `${name}=${encodeURIComponent(value)}; ${attrs}`;
  if (Array.isArray(existing)) res.setHeader('set-cookie', [...existing, cookie]);
  else if (typeof existing === 'string') res.setHeader('set-cookie', [existing, cookie]);
  else res.setHeader('set-cookie', cookie);
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
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

export async function handleTeamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: TeamRouteDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/pairing/') && !path.startsWith('/api/team/')) return false;

  const dataDir = deps.dataDir ?? config.session.dataDir;
  const method = req.method ?? 'GET';
  const cookies = parseCookies(req.headers.cookie);
  const sessionOf = (): WebSession | null => getWebSession(dataDir, cookies[SESSION_COOKIE] ?? '');

  // ── Pairing-login (public, pre-auth) ──────────────────────────────────────
  if (path === '/api/pairing/start' && method === 'POST') {
    const r = pairingStart(dataDir);
    if (r.cookie) setCookieHeader(res, r.cookie.name, r.cookie.value, r.cookie.maxAgeMs);
    jsonRes(res, r.status, r.body);
    return true;
  }
  if (path === '/api/pairing/status' && method === 'GET') {
    const r = pairingStatusView(dataDir, url.searchParams.get('pairingId') ?? '', cookies[PAIR_COOKIE] ?? '');
    jsonRes(res, r.status, r.body);
    return true;
  }
  if (path === '/api/pairing/consume' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, reason: 'bad_json' }); return true; }
    const r = pairingConsume(dataDir, String(body?.pairingId ?? ''), cookies[PAIR_COOKIE] ?? '');
    if (r.cookie) setCookieHeader(res, r.cookie.name, r.cookie.value, r.cookie.maxAgeMs);
    jsonRes(res, r.status, r.body);
    return true;
  }

  // ── Authenticated team APIs (require bmx_session) ─────────────────────────
  if (path === '/api/team/logout' && method === 'POST') {
    if (cookies[SESSION_COOKIE]) revokeWebSession(dataDir, cookies[SESSION_COOKIE]);
    setCookieHeader(res, SESSION_COOKIE, '', 0);
    jsonRes(res, 200, { ok: true });
    return true;
  }

  const session = sessionOf();
  if (!session) { jsonRes(res, 401, { ok: false, error: 'not_authenticated' }); return true; }

  if (path === '/api/team/me' && method === 'GET') {
    jsonRes(res, 200, { ok: true, user: session.identity, teamId: session.teamId });
    return true;
  }
  if (path === '/api/team/roster' && method === 'GET') {
    jsonRes(res, 200, { ok: true, ...buildTeamRoster(dataDir, session.teamId) });
    return true;
  }
  if (path === '/api/team/connectors' && method === 'GET') {
    // Definitions only — secret never leaves the box (store keeps secretRef, not plaintext).
    const connectors = listConnectors(dataDir).map(({ verify, ...rest }) => ({
      ...rest,
      verify: verify ? { type: verify.type, signatureHeader: verify.signatureHeader, timestampHeader: verify.timestampHeader } : undefined,
    }));
    jsonRes(res, 200, { ok: true, connectors });
    return true;
  }
  if (path === '/api/team/connector-stats' && method === 'GET') {
    jsonRes(res, 200, { ok: true, stats: summarizeTriggerLogs({ connectorId: url.searchParams.get('connectorId') ?? undefined }, dataDir) });
    return true;
  }
  if (path === '/api/team/trigger-logs' && method === 'GET') {
    const logs = listTriggerLogs({
      connectorId: url.searchParams.get('connectorId') ?? undefined,
      status: (url.searchParams.get('status') as 'ok' | 'error' | null) ?? undefined,
      errorCode: (url.searchParams.get('errorCode') ?? undefined) as TriggerLogListOptions['errorCode'],
      since: url.searchParams.get('since') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    }, dataDir);
    jsonRes(res, 200, { ok: true, logs });
    return true;
  }

  jsonRes(res, 404, { ok: false, error: 'not_found' });
  return true;
}
