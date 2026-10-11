// Runs on the cron trigger. One pass over every text channel in the server.
//
// Opt-out model: every text/announcement channel is monitored by default,
// including channels created after the bot was set up. The D1 `channels`
// table only holds exceptions (channels turned off, custom day thresholds)
// and archive bookkeeping.

import {
  getGlobalEnabled,
  allConfigs,
  markArchived,
  markRestored,
  defaultDays,
} from "./db.js";
import { listGuildChannels, moveChannel, snowflakeTime } from "./discord.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Channel types that hold messages and can be archived by moving category.
// 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT. Categories, voice, stage and
// forum channels are skipped.
const ARCHIVABLE_TYPES = new Set([0, 5]);

export async function runSweep(env) {
  if (!(await getGlobalEnabled(env))) {
    console.log("Global switch off; skipping sweep.");
    return;
  }

  const archiveId = env.ARCHIVE_CATEGORY_ID;
  const fallbackDays = defaultDays(env);
  const now = Date.now();

  // One REST call for the whole server. Each channel object includes
  // last_message_id, so no per-channel message fetch is needed.
  const guildChannels = (await listGuildChannels(env)) ?? [];
  const configs = new Map((await allConfigs(env)).map((c) => [c.channel_id, c]));

  for (const channel of guildChannels) {
    if (!ARCHIVABLE_TYPES.has(channel.type)) continue;

    const cfg = configs.get(channel.id);
    const enabled = cfg ? cfg.enabled === 1 : true;
    if (!enabled) continue;

    try {
      const days = cfg?.days ?? fallbackDays;
      const last = channel.last_message_id ? snowflakeTime(channel.last_message_id) : null;
      // Empty channels: treat "now" as last activity so they aren't archived
      // purely for being empty.
      const lastActive = last ?? now;
      const inactiveMs = now - lastActive;
      const threshold = days * DAY_MS;
      const inArchive = channel.parent_id === archiveId;
      const archivedByBot = cfg?.is_archived === 1;

      if (!inArchive && inactiveMs >= threshold) {
        // Stale -> archive. Remember where it lived.
        await moveChannel(env, channel.id, archiveId);
        await markArchived(env, channel.id, channel.parent_id ?? null);
        console.log(`Archived #${channel.name} (${channel.id})`);
      } else if (inArchive && archivedByBot && inactiveMs < threshold) {
        // Activity while archived -> restore to original category.
        // Only channels the bot archived itself are restored; anything
        // placed in the archive category by hand is left alone.
        const dest = cfg.original_parent_id ?? null;
        await moveChannel(env, channel.id, dest);
        await markRestored(env, channel.id);
        console.log(`Restored #${channel.name} (${channel.id}) -> ${dest}`);
      }
    } catch (err) {
      console.error(`Channel ${channel.id} failed:`, err.message);
      // Keep going; one bad channel shouldn't stop the sweep.
    }
  }
}
