// src/dashboard/operator-selector.ts
//
// Helper for the "Create new group" flow: picks which of the user-selected
// bots should issue the Lark create-chat call. Feishu makes the calling bot
// the implicit first member + owner, so the creator MUST be one the user
// explicitly chose — otherwise we'd silently add an extra bot to the chat.
//
// We also surface the operator's open_id under that bot's scope (from the
// daemon's pre-resolved allowedUsers) so the route can auto-invite + transfer
// ownership in the same request. open_ids are app-scoped, so the open_id and
// the creator daemon must come from the SAME bot.
//
// Isolated from dashboard.ts (which is a pm2 entry script) so it stays unit-
// testable.

export interface DaemonInfoForPick {
  larkAppId: string;
  resolvedAllowedUsers: string[];
}

export interface CreatorPick {
  /** larkAppId of the bot that should issue the chat-create call. */
  creatorLarkAppId: string;
  /** open_ids in the creator bot's app scope to invite (may be empty). */
  userOpenIds: string[];
}

/**
 * From the user's selected larkAppIds, pick the bot to use as chat creator.
 *
 * Preference: first selected bot that's online AND has a non-empty allowlist
 * (so the operator can be auto-invited). Falls back to the first selected
 * online bot regardless of allowlist (auto-invite skipped — frontend surfaces
 * the warn branch). Returns null if none of the selected bots are online.
 */
export function pickCreatorForGroup(
  selectedLarkAppIds: string[],
  getOnlineDaemon: (larkAppId: string) => DaemonInfoForPick | undefined,
): CreatorPick | null {
  const onlineSelected: DaemonInfoForPick[] = [];
  for (const id of selectedLarkAppIds) {
    const d = getOnlineDaemon(id);
    if (d) onlineSelected.push(d);
  }
  if (onlineSelected.length === 0) return null;
  const withUsers = onlineSelected.find(d => d.resolvedAllowedUsers.length > 0);
  const chosen = withUsers ?? onlineSelected[0];
  return {
    creatorLarkAppId: chosen.larkAppId,
    userOpenIds: [...chosen.resolvedAllowedUsers],
  };
}
