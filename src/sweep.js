// Runs on the cron trigger. One pass over all monitored channels.

import { getGlobalEnabled, getEnabledChannels, markArchived, markRestored } from "./db.js";
import { lastMessageTime, moveChannel, getChannel } from "./discord.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runSweep(env) {
  if (!(await getGlobalEnabled(env))) {
    console.log("Global switch off; skipping sweep.");
    return;
  }

  const archiveId = env.ARCHIVE_CATEGORY_ID;
  const channels = await getEnabledChannels(env);
  const now = Date.now();

  for (const cfg of channels) {
    try {
      const channel = await getChannel(env, cfg.channel_id);
      if (!channel || !channel.id) continue; // deleted channel

      const last = await lastMessageTime(env, cfg.channel_id);
      // Empty channels: treat "now" as last activity so they aren't archived
      // purely for being empty. Adjust if you'd rather archive empties.
      const lastActive = last ?? now;
      const inactiveMs = now - lastActive;
      const threshold = cfg.days * DAY_MS;
      const inArchive = channel.parent_id === archiveId;

      if (!inArchive && inactiveMs >= threshold) {
        // Stale -> archive. Remember where it lived.
        await moveChannel(env, cfg.channel_id, archiveId);
        await markArchived(env, cfg.channel_id, channel.parent_id ?? null);
        console.log(`Archived ${cfg.channel_id}`);
      } else if (inArchive && inactiveMs < threshold) {
        // Activity while archived -> restore to original category.
        const dest = cfg.original_parent_id ?? null;
        await moveChannel(env, cfg.channel_id, dest);
        await markRestored(env, cfg.channel_id);
        console.log(`Restored ${cfg.channel_id} -> ${dest}`);
      }
    } catch (err) {
      console.error(`Channel ${cfg.channel_id} failed:`, err.message);
      // Keep going; one bad channel shouldn't stop the sweep.
    }
  }
}
