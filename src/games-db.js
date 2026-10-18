// D1 access for the saved list of games offered by /gaming autocomplete.

import { gameKey, tidyGameName, MAX_GAME_LEN } from "./sessions.js";
import { findOnRawg, hasRawg } from "./rawg.js";

// Discord shows at most 25 autocomplete choices.
export const MAX_SUGGESTIONS = 25;

// Saved games matching what's been typed so far. With nothing typed, the most
// used games come first. Otherwise an exact match comes first, then names that
// start with the text, then names that merely contain it.
export async function suggestGames(env, typed, limit = MAX_SUGGESTIONS) {
  const key = gameKey(typed);
  if (!key) {
    const { results } = await env.DB.prepare(
      "SELECT name, name_key, coop_status FROM games ORDER BY uses DESC, last_used DESC LIMIT ?"
    )
      .bind(limit)
      .all();
    return results ?? [];
  }
  // instr() rather than LIKE, so %, _ in game names need no escaping.
  const { results } = await env.DB.prepare(
    `SELECT name, name_key, coop_status FROM games
     WHERE instr(name_key, ?1) > 0
     ORDER BY name_key = ?1 DESC, instr(name_key, ?1) = 1 DESC, uses DESC, last_used DESC
     LIMIT ?2`
  )
    .bind(key, limit)
    .all();
  return results ?? [];
}

// Looks up a saved game by name, ignoring case and spacing.
export async function findGame(env, name) {
  const key = gameKey(name);
  if (!key) return null;
  return env.DB.prepare("SELECT * FROM games WHERE name_key = ?").bind(key).first();
}

// Records that a session was posted for this game. New games are added with
// the spelling first used; known games keep their saved spelling.
// Returns the saved display name.
export async function recordGame(env, name, userId) {
  const display = tidyGameName(name).slice(0, MAX_GAME_LEN);
  const key = gameKey(display);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO games (name_key, name, uses, last_used, added_by, added_at)
     VALUES (?1, ?2, 1, ?3, ?4, ?3)
     ON CONFLICT(name_key) DO UPDATE SET uses = uses + 1, last_used = ?3`
  )
    .bind(key, display, now, userId ?? null)
    .run();
  const row = await findGame(env, key);
  return row?.name ?? display;
}

// Deletes a saved game. Returns the removed row, or null if it wasn't saved.
export async function removeGame(env, name) {
  const row = await findGame(env, name);
  if (!row) return null;
  await env.DB.prepare("DELETE FROM games WHERE name_key = ?").bind(row.name_key).run();
  return row;
}

// Sets a game's co-op status, adding the game to the saved list if it's new
// (so it's offered by /gaming too). New games start with no sessions posted.
// Returns { name, previous } — previous is the old status, or null.
export async function setCoopStatus(env, name, status, userId) {
  const display = tidyGameName(name).slice(0, MAX_GAME_LEN);
  const key = gameKey(display);
  const before = await findGame(env, key);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO games (name_key, name, uses, last_used, added_by, added_at, coop_status)
     VALUES (?1, ?2, 0, 0, ?3, ?4, ?5)
     ON CONFLICT(name_key) DO UPDATE SET coop_status = ?5`
  )
    .bind(key, display, userId ?? null, now, status)
    .run();
  return { name: before?.name ?? display, previous: before?.coop_status ?? null };
}

// Botdog's posts of the co-op list in the co-op channel. Normally just one;
// more only while a newer post is replacing an older one.
export async function recordBoardPost(env, channelId, messageId) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO coop_board_posts (message_id, channel_id, posted_at) VALUES (?, ?, ?)"
  )
    .bind(messageId, channelId, Date.now())
    .run();
}

// Every recorded post except the newest. Discord message ids grow over time,
// so the largest id is the newest post, whichever request recorded it first.
export async function olderBoardPosts(env) {
  const { results } = await env.DB.prepare(
    `SELECT message_id, channel_id FROM coop_board_posts
     WHERE message_id != (SELECT message_id FROM coop_board_posts ORDER BY CAST(message_id AS INTEGER) DESC LIMIT 1)`
  ).all();
  return results ?? [];
}

export async function forgetBoardPost(env, messageId) {
  await env.DB.prepare("DELETE FROM coop_board_posts WHERE message_id = ?").bind(messageId).run();
}

// Games on the co-op list, optionally only those with one status, A–Z.
// Includes the RAWG details shown on each line of the list.
const COOP_COLUMNS = "name, coop_status, rawg_id, metacritic, playtime";
export async function listCoopGames(env, status = null) {
  const { results } = status
    ? await env.DB.prepare(
        `SELECT ${COOP_COLUMNS} FROM games WHERE coop_status = ? ORDER BY name_key`
      )
        .bind(status)
        .all()
    : await env.DB.prepare(
        `SELECT ${COOP_COLUMNS} FROM games WHERE coop_status IS NOT NULL ORDER BY name_key`
      ).all();
  return results ?? [];
}

// RAWG fields saved on a game row (see migrations/0006_add_rawg.sql).
export const RAWG_FIELDS = [
  "rawg_id",
  "rawg_slug",
  "rawg_name",
  "image_url",
  "metacritic",
  "rawg_rating",
  "rawg_ratings_count",
  "released",
  "playtime",
  "genres",
  "platforms",
  "coop_modes",
];

// Saves what RAWG returned for a game. A null summary (no match) only records
// that the game was looked up, keeping any details saved before.
export async function saveRawg(env, nameKey, summary) {
  const now = Date.now();
  if (!summary) {
    await env.DB.prepare("UPDATE games SET rawg_checked_at = ? WHERE name_key = ?").bind(now, nameKey).run();
    return;
  }
  const sets = RAWG_FIELDS.map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE games SET ${sets}, rawg_checked_at = ? WHERE name_key = ?`)
    .bind(...RAWG_FIELDS.map((f) => summary[f] ?? null), now, nameKey)
    .run();
}

// Looks a saved game up on RAWG the first time it's seen, and saves the
// result. Games already looked up (matched or not) are left alone; /games
// refresh and /games link are how a missed or wrong match gets fixed.
// Returns the updated row, or null if nothing new was found.
export async function lookUpIfNew(env, name) {
  if (!hasRawg(env)) return null;
  const row = await findGame(env, name);
  if (!row || row.rawg_checked_at) return null;
  const summary = await findOnRawg(env, row.name);
  await saveRawg(env, row.name_key, summary);
  return summary ? findGame(env, row.name_key) : null;
}

// Saved games with no RAWG match yet: never looked up first, then the ones
// RAWG didn't find, oldest attempt first.
export async function unmatchedGames(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM games WHERE rawg_id IS NULL
     ORDER BY rawg_checked_at IS NOT NULL, rawg_checked_at, name_key LIMIT ?`
  )
    .bind(limit)
    .all();
  return results ?? [];
}

// Saved games never looked up on RAWG.
export async function countUnchecked(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE rawg_checked_at IS NULL").first();
  return row?.n ?? 0;
}
