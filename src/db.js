// D1 access helpers. Keeps SQL in one place.

export async function getGlobalEnabled(env) {
  const row = await env.DB.prepare(
    "SELECT global_enabled FROM settings WHERE id = 1"
  ).first();
  return row ? row.global_enabled === 1 : true;
}

export async function setGlobalEnabled(env, on) {
  await env.DB.prepare("UPDATE settings SET global_enabled = ? WHERE id = 1")
    .bind(on ? 1 : 0)
    .run();
}

export async function getChannelConfig(env, channelId) {
  return env.DB.prepare("SELECT * FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .first();
}

export async function getEnabledChannels(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM channels WHERE enabled = 1"
  ).all();
  return results ?? [];
}

// Upsert enable state, defaulting days to 30 for a brand-new channel.
export async function setChannelEnabled(env, channelId, enabled) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days)
     VALUES (?, ?, 30)
     ON CONFLICT(channel_id) DO UPDATE SET enabled = excluded.enabled`
  )
    .bind(channelId, enabled ? 1 : 0)
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

// Record archive state + where the channel came from.
export async function markArchived(env, channelId, originalParentId) {
  await env.DB.prepare(
    "UPDATE channels SET is_archived = 1, original_parent_id = ? WHERE channel_id = ?"
  )
    .bind(originalParentId, channelId)
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
