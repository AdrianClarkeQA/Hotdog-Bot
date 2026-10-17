// D1 access for the saved list of games offered by /gaming autocomplete.

import { gameKey, tidyGameName, MAX_GAME_LEN } from "./sessions.js";

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

// Games on the co-op list, optionally only those with one status, A–Z.
export async function listCoopGames(env, status = null) {
  const { results } = status
    ? await env.DB.prepare(
        "SELECT name, coop_status FROM games WHERE coop_status = ? ORDER BY name_key"
      )
        .bind(status)
        .all()
    : await env.DB.prepare(
        "SELECT name, coop_status FROM games WHERE coop_status IS NOT NULL ORDER BY name_key"
      ).all();
  return results ?? [];
}
