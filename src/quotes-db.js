// D1 access for saved quotes.
//
// A person's quotes are grouped by speaker_key:
//   "u:<user id>"         someone picked from the server member list
//   "n:<lowercased name>" a name typed in for someone not in the server

// Discord shows at most 25 autocomplete choices.
export const MAX_SUGGESTIONS = 25;

// /quote rows still waiting for "who said it?" after this long are dropped.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function tidyName(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

export function nameKey(name) {
  const key = tidyName(name).normalize("NFKC").toLowerCase();
  return key ? `n:${key}` : null;
}

export const userKey = (userId) => `u:${userId}`;

// D1 returns { meta: { changes } }; the test stand-in returns { changes }.
const changes = (res) => res?.meta?.changes ?? res?.changes ?? 0;

// Stores a /quote while Botdog asks who said it. Returns the new quote id.
export async function createPendingQuote(env, text, addedBy) {
  const now = Date.now();
  // Tidy up abandoned prompts (dismissed without picking anyone).
  await env.DB.prepare("DELETE FROM quotes WHERE posted = 0 AND created_at < ?")
    .bind(now - PENDING_TTL_MS)
    .run();
  const row = await env.DB.prepare(
    "INSERT INTO quotes (text, added_by, created_at, posted) VALUES (?, ?, ?, 0) RETURNING id"
  )
    .bind(text, addedBy ?? null, now)
    .first();
  return row.id;
}

export async function getQuote(env, id) {
  return env.DB.prepare("SELECT * FROM quotes WHERE id = ?").bind(id).first();
}

// Attaches the speaker to a waiting /quote and marks it posted, in one step so
// a double-click can't post it twice. Returns true if this call claimed it.
export async function claimPendingQuote(env, id, speaker) {
  const res = await env.DB.prepare(
    `UPDATE quotes SET speaker_id = ?, speaker_name = ?, speaker_key = ?, posted = 1
     WHERE id = ? AND posted = 0`
  )
    .bind(speaker.id ?? null, speaker.name, speaker.key, id)
    .run();
  return changes(res) > 0;
}

// Puts a claimed quote back to waiting (posting to Discord failed).
export async function unclaimQuote(env, id) {
  await env.DB.prepare(
    "UPDATE quotes SET speaker_id = NULL, speaker_name = NULL, speaker_key = NULL, posted = 0 WHERE id = ?"
  )
    .bind(id)
    .run();
}

export async function deleteQuote(env, id) {
  await env.DB.prepare("DELETE FROM quotes WHERE id = ?").bind(id).run();
}

// Saves a quote that already knows its speaker ("Save as quote").
export async function insertPostedQuote(env, { text, speaker, addedBy, sourceUrl }) {
  const row = await env.DB.prepare(
    `INSERT INTO quotes (text, speaker_id, speaker_name, speaker_key, added_by, created_at, posted, source_url)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`
  )
    .bind(text, speaker.id ?? null, speaker.name, speaker.key, addedBy ?? null, Date.now(), sourceUrl ?? null)
    .first();
  return row.id;
}

export async function findQuoteBySource(env, sourceUrl) {
  return env.DB.prepare("SELECT id FROM quotes WHERE source_url = ? AND posted = 1").bind(sourceUrl).first();
}

// People who have been quoted, for /quotes autocomplete: most-quoted first,
// filtered by what's been typed. Each person's latest name is shown.
export async function suggestSpeakers(env, typed, limit = MAX_SUGGESTIONS) {
  const needle = tidyName(typed).normalize("NFKC").toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT q.speaker_key, q.speaker_name, c.n
     FROM (SELECT speaker_key, COUNT(*) AS n, MAX(id) AS last_id
           FROM quotes WHERE posted = 1 AND speaker_key IS NOT NULL
           GROUP BY speaker_key) c
     JOIN quotes q ON q.id = c.last_id
     WHERE ?1 = '' OR instr(lower(q.speaker_name), ?1) > 0
     ORDER BY c.n DESC, c.last_id DESC
     LIMIT ?2`
  )
    .bind(needle, limit)
    .all();
  return results ?? [];
}

// Works out whose quotes /quotes means. Usually the value is a key picked from
// autocomplete; if a name was typed without picking, match it by name.
export async function resolveSpeaker(env, value) {
  const raw = tidyName(value);
  if (!raw) return null;
  const byKey = /^[un]:/.test(raw) ? raw : null;
  const row = await env.DB.prepare(
    `SELECT speaker_key, speaker_id, speaker_name FROM quotes
     WHERE posted = 1 AND (speaker_key = ?1 OR lower(speaker_name) = ?2)
     ORDER BY speaker_key = ?1 DESC, id DESC LIMIT 1`
  )
    .bind(byKey ?? "", raw.normalize("NFKC").toLowerCase())
    .first();
  return row ?? null;
}

// Latest quotes for one person, newest first.
export async function latestQuotes(env, speakerKey, limit = 3) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM quotes WHERE posted = 1 AND speaker_key = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(speakerKey, limit)
    .all();
  return results ?? [];
}
