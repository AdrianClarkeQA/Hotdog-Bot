// D1 access helpers. Keeps SQL in one place.
//
// The `channels` table holds exceptions only: every text channel is
// monitored by default with DEFAULT_DAYS. A row exists when a channel has
// been turned off, given a custom threshold, or archived by the bot.

const FALLBACK_DAYS = 30;

// Default inactivity threshold from the DEFAULT_DAYS var.
export function defaultDays(env) {
  const n = parseInt(env.DEFAULT_DAYS, 10);
  return Number.isFinite(n) && n >= 1 ? n : FALLBACK_DAYS;
}

export async function getGlobalEnabled(env) {
  const row = await env.DB.prepare(
    "SELECT global_enabled FROM settings WHERE id = 1"
  ).first();
  return row ? row.global_enabled === 1 : true;
}

export async function setGlobalEnabled(env, on) {
  await env.DB.prepare(
    `INSERT INTO settings (id, global_enabled) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET global_enabled = excluded.global_enabled`
  )
    .bind(on ? 1 : 0)
    .run();
}

export async function getChannelConfig(env, channelId) {
  return env.DB.prepare("SELECT * FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .first();
}

// Upsert enable state. A new row gets the default threshold.
export async function setChannelEnabled(env, channelId, enabled) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days)
     VALUES (?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET enabled = excluded.enabled`
  )
    .bind(channelId, enabled ? 1 : 0, defaultDays(env))
    .run();
}

export async function setChannelDays(env, channelId, days) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days)
     VALUES (?, 1, ?)
     ON CONFLICT(channel_id) DO UPDATE SET days = excluded.days`
  )
    .bind(channelId, days)
    .run();
}

// Record archive state + where the channel came from. Upserts, because
// under the opt-out model most archived channels have no row yet.
export async function markArchived(env, channelId, originalParentId) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days, original_parent_id, is_archived)
     VALUES (?, 1, ?, ?, 1)
     ON CONFLICT(channel_id) DO UPDATE SET
       is_archived = 1,
       original_parent_id = excluded.original_parent_id`
  )
    .bind(channelId, defaultDays(env), originalParentId)
    .run();
}

export async function markRestored(env, channelId) {
  await env.DB.prepare(
    "UPDATE channels SET is_archived = 0, original_parent_id = NULL WHERE channel_id = ?"
  )
    .bind(channelId)
    .run();
}

export async function allConfigs(env) {
  const { results } = await env.DB.prepare("SELECT * FROM channels").all();
  return results ?? [];
}
