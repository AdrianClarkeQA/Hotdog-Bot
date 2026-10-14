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

// Inactivity threshold for channels with no override row.
// Set DEFAULT_DAYS in wrangler.toml [vars]; falls back to 30.
export function defaultDays(env) {
  const n = parseInt(env.DEFAULT_DAYS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 30;
}

// Upsert enable state, using the default threshold for a brand-new row.
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

// Record archive state + where the channel came from. Upserts, because a
// channel covered only by the default has no row until it is first archived.
export async function markArchived(env, channelId, originalParentId, days) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days, original_parent_id, is_archived)
     VALUES (?, 1, ?, ?, 1)
     ON CONFLICT(channel_id) DO UPDATE SET
       is_archived = 1, original_parent_id = excluded.original_parent_id`
  )
    .bind(channelId, days, originalParentId)
    .run();
}

// Records a restore. original_parent_id is kept as the channel's "home"
// category (where it was restored to), so if it ends up in the archive again
// by any route, Botdog still knows where it belongs. Upserts, because a
// channel archived by hand has no row until its first restore.
// restored_at gives a restored channel a fresh inactivity window, so a
// quiet channel isn't swept straight back into the archive.
export async function markRestored(env, channelId, homeParentId) {
  await env.DB.prepare(
    `INSERT INTO channels (channel_id, enabled, days, original_parent_id, is_archived, restored_at)
     VALUES (?, 1, ?, ?, 0, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       is_archived = 0,
       original_parent_id = excluded.original_parent_id,
       restored_at = excluded.restored_at`
  )
    .bind(channelId, defaultDays(env), homeParentId, Date.now())
    .run();
}

// Whether Botdog knows which category a channel belongs in. A channel Botdog
// archived has a recorded home even if that home was "no category" (NULL).
export function hasKnownHome(cfg) {
  return !!cfg && (cfg.is_archived === 1 || cfg.original_parent_id != null);
}

export async function allConfigs(env) {
  const { results } = await env.DB.prepare("SELECT * FROM channels").all();
  return results ?? [];
}
