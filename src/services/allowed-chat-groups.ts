import type { BotState } from '../bot-registry.js';
import { listChatMemberOpenIds } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';

export async function resolveAllowedChatGroups(bot: BotState): Promise<void> {
  const chatIds = bot.config.allowedChatGroups ?? [];
  if (chatIds.length === 0) return;

  const resolved = new Set<string>();
  for (const chatId of chatIds) {
    try {
      const members = await listChatMemberOpenIds(bot.config.larkAppId, chatId);
      for (const openId of members) resolved.add(openId);
      logger.info(`[${bot.config.larkAppId}] Resolved allowedChatGroups ${chatId}: ${members.length} member(s)`);
    } catch (err: any) {
      logger.warn(`[${bot.config.larkAppId}] Failed to resolve allowedChatGroups ${chatId}: ${err?.message ?? err}`);
    }
  }
  bot.resolvedAllowedChatGroupUsers = [...resolved];
}
