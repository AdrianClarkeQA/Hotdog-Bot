// Works out which channels the archiver covers and with what settings.
// Every text/announcement channel in the guild is covered by default;
// rows in the D1 `channels` table are per-channel overrides.

import { allConfigs, defaultDays } from "./db.js";
import { listGuildChannels } from "./discord.js";

// Discord channel types the archiver handles.
const TEXT = 0;
const ANNOUNCEMENT = 5;
const COVERED_TYPES = new Set([TEXT, ANNOUNCEMENT]);

// Returns [{ channel, cfg, enabled, days, isDefault }] for every covered
// channel, in Discord's sidebar order.
export async function effectiveChannels(env) {
  const [guildChannels, configs] = await Promise.all([
    listGuildChannels(env),
    allConfigs(env),
  ]);
  const byId = new Map(configs.map((c) => [c.channel_id, c]));
  const fallbackDays = defaultDays(env);

  return (guildChannels ?? [])
    .filter((ch) => COVERED_TYPES.has(ch.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((channel) => {
      const cfg = byId.get(channel.id) ?? null;
      return {
        channel,
        cfg,
        enabled: cfg ? cfg.enabled === 1 : true,
        days: cfg ? cfg.days : fallbackDays,
        isDefault: !cfg,
      };
    });
}
