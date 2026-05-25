/**
 * Federation hub roster aggregation + hub HTTP endpoints (join/sync/roster).
 * Run: pnpm vitest run test/federation-api.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return state.dataDir; } } },
}));

import { handleFederationApi } from '../src/dashboard/federation-api.js';
import { buildFederatedRoster } from '../src/services/federation-roster.js';
import { registerDeployment } from '../src/services/federation-store.js';
import { ensureDefaultTeam, addMember, DEFAULT_TEAM_ID } from '../src/services/team-store.js';
import { createInvite } from '../src/services/invite-store.js';
import { addMembership } from '../src/services/federation-membership-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-fedapi-')); state.dataDir = dataDir; });

function writeBots(entries: any[]) { writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries)); }
function makeReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): any {
  const req: any = { method, url: path, headers };
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {}, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number, h?: any) => { res.statusCode = s; if (h) Object.assign(res._headers, h); };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const call = (req: any, res: any, path: string) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir });
const callWithGroup = (req: any, res: any, path: string, createTeamGroup: any) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir, createTeamGroup });
const json = (res: any) => JSON.parse(res._body);

describe('buildFederatedRoster', () => {
  it('merges local bots (tagged local) with federated deployments\' bots', () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地Bot', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, {
      deploymentId: 'dep_remote', name: '同事的部署',
      bots: [{ larkAppId: 'cli_remote', botName: '远端Bot', cliId: 'codex' }],
    });
    const r = buildFederatedRoster(dataDir, DEFAULT_TEAM_ID);
    expect(r.bots.map(b => b.name).sort()).toEqual(['本地Bot', '远端Bot']);
    const local = r.bots.find(b => b.larkAppId === 'cli_local')!;
    const remote = r.bots.find(b => b.larkAppId === 'cli_remote')!;
    expect(local.deployment.local).toBe(true);
    expect(remote.deployment.local).toBe(false);
    expect(remote.deployment.name).toBe('同事的部署');
    // deployments list: local first, then remote
    expect(r.deployments[0].local).toBe(true);
    expect(r.deployments.find(d => d.id === 'dep_remote')?.botCount).toBe(1);
  });
});

describe('handleFederationApi', () => {
  it('returns false for unrelated paths', async () => {
    expect(await call(makeReq('GET', '/api/sessions'), makeRes(), '/api/sessions')).toBe(false);
  });

  it('join → sync → roster full flow', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'HubBot', cliId: 'claude' }]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');

    // join with invite
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', {
      inviteCode: code,
      deployment: { deploymentId: 'dep_b', name: 'B部署', bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }] },
    }), res, '/api/federation/join');
    expect(res.statusCode).toBe(200);
    const { syncToken, teamId } = json(res);
    expect(teamId).toBe(DEFAULT_TEAM_ID);
    expect(syncToken.length).toBeGreaterThan(20);

    // sync updates bots
    res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken, bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }, { larkAppId: 'cli_b2', botName: 'B2', cliId: 'gemini' }] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(200);

    // roster reflects hub local + B's two bots (token in Authorization header)
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(200);
    expect(json(res).bots.map((b: any) => b.larkAppId).sort()).toEqual(['cli_b1', 'cli_b2', 'cli_hub']);

    // a second deployment can't re-bind by re-joining with the same id → 409
    const { code: code2 } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code2, deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('deployment_already_joined');

    // leave (authed by syncToken) drops the deployment; roster then 403s
    res = makeRes();
    await call(makeReq('POST', '/api/federation/leave', { syncToken }), res, '/api/federation/leave');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('roster still accepts ?syncToken= as a short-term compat fallback', async () => {
    writeBots([]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code, deployment: { deploymentId: 'dep_c', name: 'C', bots: [] } }), res, '/api/federation/join');
    const { syncToken } = json(res);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=' + syncToken), res, '/api/federation/roster?syncToken=' + syncToken);
    expect(res.statusCode).toBe(200);
  });

  it('join rejects a bad invite code (403)', async () => {
    const res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'NOPE', deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_not_found');
  });

  it('sync / roster reject an unknown token (403)', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken: 'bogus', bots: [] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(403);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=bogus'), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('delegate-group: valid delegationToken → creates via injected createTeamGroup; bad token 403; no dep 501', async () => {
    // this deployment joined a hub and issued delegationToken 'DTOK' to it
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    let captured: any = null;
    const createTeamGroup = vi.fn(async (args: any) => { captured = args; return { ok: true, chatId: 'oc_deleg', shareLink: 'https://x', invalidBotIds: [] }; });
    // valid token in Authorization header
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'] }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_deleg');
    expect(captured).toMatchObject({ name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'] });
    // unknown token → 403, not delegated
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('NOPE')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    // no createTeamGroup dep → 501
    res = makeRes();
    await call(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('DTOK')), res, '/api/federation/delegate-group');
    expect(res.statusCode).toBe(501);
  });

  it('join requires inviteCode + deployment', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { deployment: { deploymentId: 'd', name: 'n', bots: [] } }), res, '/api/federation/join');
    expect(json(res).error).toBe('code_required');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'x' }), res, '/api/federation/join');
    expect(json(res).error).toBe('deployment_required');
  });
});
