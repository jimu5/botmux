import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatMembersGet = vi.fn();

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({
    im: {
      v1: {
        chatMembers: {
          get: chatMembersGet,
        },
      },
    },
  })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listChatMemberOpenIds } from '../src/im/lark/client.js';

describe('listChatMemberOpenIds', () => {
  beforeEach(() => chatMembersGet.mockReset());

  it('paginates chat members and returns open_ids', async () => {
    chatMembersGet
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: 'ou_a' }, { member_id: 'ou_b' }],
          has_more: true,
          page_token: 'next',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: 'ou_c' }, { name: 'missing id' }],
          has_more: false,
        },
      });

    await expect(listChatMemberOpenIds('app_a', 'oc_team')).resolves.toEqual(['ou_a', 'ou_b', 'ou_c']);
    expect(chatMembersGet).toHaveBeenNthCalledWith(1, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 100 },
    });
    expect(chatMembersGet).toHaveBeenNthCalledWith(2, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 100, page_token: 'next' },
    });
  });

  it('throws on Lark API errors', async () => {
    chatMembersGet.mockResolvedValueOnce({ code: 999, msg: 'denied' });
    await expect(listChatMemberOpenIds('app_a', 'oc_denied'))
      .rejects.toThrow('Failed to list chat members for oc_denied: denied (code=999)');
  });
});
