import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListChatMemberOpenIds = vi.fn();

vi.mock('../src/im/lark/client.js', () => ({
  listChatMemberOpenIds: (...args: any[]) => mockListChatMemberOpenIds(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveAllowedChatGroups } from '../src/services/allowed-chat-groups.js';

describe('resolveAllowedChatGroups', () => {
  beforeEach(() => mockListChatMemberOpenIds.mockReset());

  it('resolves configured chat groups into a de-duplicated startup snapshot', async () => {
    mockListChatMemberOpenIds
      .mockResolvedValueOnce(['ou_a', 'ou_b'])
      .mockResolvedValueOnce(['ou_b', 'ou_c']);
    const bot = {
      config: {
        larkAppId: 'app_a',
        larkAppSecret: 'secret',
        cliId: 'claude-code' as const,
        allowedChatGroups: ['oc_team', 'oc_project'],
      },
      client: {} as any,
      resolvedAllowedUsers: ['ou_admin'],
      resolvedAllowedChatGroupUsers: [],
    };

    await resolveAllowedChatGroups(bot);

    expect(mockListChatMemberOpenIds).toHaveBeenNthCalledWith(1, 'app_a', 'oc_team');
    expect(mockListChatMemberOpenIds).toHaveBeenNthCalledWith(2, 'app_a', 'oc_project');
    expect(bot.resolvedAllowedChatGroupUsers).toEqual(['ou_a', 'ou_b', 'ou_c']);
    expect(bot.resolvedAllowedUsers).toEqual(['ou_admin']);
  });

  it('skips failed groups without granting their members or blocking successful groups', async () => {
    mockListChatMemberOpenIds
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(['ou_ok']);
    const bot = {
      config: {
        larkAppId: 'app_a',
        larkAppSecret: 'secret',
        cliId: 'claude-code' as const,
        allowedChatGroups: ['oc_denied', 'oc_ok'],
      },
      client: {} as any,
      resolvedAllowedUsers: [],
      resolvedAllowedChatGroupUsers: ['ou_stale'],
    };

    await resolveAllowedChatGroups(bot);

    expect(mockListChatMemberOpenIds).toHaveBeenNthCalledWith(1, 'app_a', 'oc_denied');
    expect(mockListChatMemberOpenIds).toHaveBeenNthCalledWith(2, 'app_a', 'oc_ok');
    expect(bot.resolvedAllowedChatGroupUsers).toEqual(['ou_ok']);
  });
});
