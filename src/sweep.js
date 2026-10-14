// Runs on the cron trigger. One pass over every covered channel.
// All text/announcement channels are covered by default; D1 rows override.
// Set DRY_RUN = "true" in wrangler.toml to log decisions without moving anything.

import { getGlobalEnabled, markArchived, markRestored, hasKnownHome } from "./db.js";
import { lastMessageTime, moveChannel } from "./discord.js";
import { effectiveChannels } from "./coverage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runSweep(env) {
  if (!(await getGlobalEnabled(env))) {
    console.log("Global switch off; skipping sweep.");
    return;
  }

  const dryRun = env.DRY_RUN === "true";
  const archiveId = env.ARCHIVE_CATEGORY_ID;
  const channels = await effectiveChannels(env);
  const now = Date.now();
  if (dryRun) console.log(`DRY RUN: checking ${channels.length} channel(s), nothing will move.`);

  for (const { channel, cfg, enabled, days } of channels) {
    if (!enabled) continue;
    const inArchive = channel.parent_id === archiveId;

    // A channel sitting in the archive with no known home (put there by hand
    // and never restored) has nowhere to go back to, so leave it alone.
    // /arc restore asks for its category and records it.
    if (inArchive && !hasKnownHome(cfg)) continue;

    try {
      const last = await lastMessageTime(env, channel.id);
      // Empty channels: treat "now" as last activity so they aren't archived
      // purely for being empty. Adjust if you'd rather archive empties.
      const lastActive = last ?? now;
      const inactiveMs = now - lastActive;
      const threshold = days * DAY_MS;
      const label = `#${channel.name} (${channel.id})`;

      // Since a restore, the clock starts from the restore time rather than
      // the last message, so restored channels get a full threshold period.
      const sinceRestoreMs = cfg?.restored_at ? now - cfg.restored_at : Infinity;

      if (!inArchive && Math.min(inactiveMs, sinceRestoreMs) >= threshold) {
        // Stale -> archive. Remember where it lived.
        if (dryRun) {
          console.log(`DRY RUN: would archive ${label} — ${Math.floor(inactiveMs / DAY_MS)}d idle, limit ${days}d`);
          continue;
        }
        await moveChannel(env, channel.id, archiveId);
        await markArchived(env, channel.id, channel.parent_id ?? null, days);
        console.log(`Archived ${label}`);
      } else if (inArchive && inactiveMs < threshold) {
        // Activity while archived -> restore to original category.
        const dest = cfg.original_parent_id ?? null;
        if (dryRun) {
          console.log(`DRY RUN: would restore ${label} -> ${dest}`);
          continue;
        }
        await moveChannel(env, channel.id, dest);
        await markRestored(env, channel.id, dest);
        console.log(`Restored ${label} -> ${dest}`);
      }
    } catch (err) {
      console.error(`Channel ${channel.id} failed:`, err.message);
      // Keep going; one bad channel shouldn't stop the sweep.
    }
  }
}
