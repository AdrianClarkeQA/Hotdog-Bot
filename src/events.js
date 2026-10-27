// Discord events for /gaming (v1.11.0).
//
// /gaming creates a voice event in VOICE_CHANNEL_ID ("voice-chat") and posts
// the event's link in GAMING_CHANNEL_ID ("gaming-chatter"), where Discord shows
// it as an event card. Each post is saved in session_posts, and the nightly
// clean-up (index.js scheduled()) deletes the posts for sessions that started
// on an earlier day. The events themselves are left alone.
//
// Voice events have no end time. They stay "Scheduled" until someone presses
// Start in Discord; Discord cancels one that isn't started within a few hours
// of its start time.

import { rawgPage } from "./rawg.js";
import { formatReleased } from "./game-info.js";
import { startOfDayMs } from "./sessions.js";
import { deleteMessage } from "./discord.js";

// Discord's limits for an event's name and description.
export const MAX_EVENT_NAME = 100;
export const MAX_EVENT_DESCRIPTION = 1000;

// Titles picked at random. {game} is replaced with the game's name. Add or
// remove lines freely. No questions: sessions are agreed beforehand.
export const GAME_TITLES = [
  "{game} gaming",
  "{game} night",
  "{game} session",
  "Squad up: {game}",
  "Dropping into {game}",
  "Back on {game}",
  "{game} with the crew",
  "A spot of {game}",
];

// Titles for a session planned before the game is picked.
export const NO_GAME_TITLES = ["Gaming session", "Game night", "Game night (game TBC)"];

// Fills a title template, shortening a long game name so the whole title fits
// Discord's 100-character limit.
export function fillTitle(template, game = "") {
  if (!template.includes("{game}")) return template.slice(0, MAX_EVENT_NAME);
  const room = MAX_EVENT_NAME - (template.length - "{game}".length);
  const name = game.length > room ? `${game.slice(0, room - 1).trimEnd()}…` : game;
  return template.replace("{game}", name);
}

// Picks a random title, never the same template as `last` (the previous
// session's) when there's another to choose from. `random` is swappable for tests.
// Returns { template, name }.
export function pickTitle(game, { last = null, random = Math.random } = {}) {
  const list = game ? GAME_TITLES : NO_GAME_TITLES;
  const choices = list.length > 1 ? list.filter((t) => t !== last) : list;
  const template = choices[Math.floor(random() * choices.length)] ?? list[0];
  return { template, name: fillTitle(template, game) };
}

// The event description, from a game's saved RAWG details. Null when the game
// has no RAWG match (or there's no game). Playtime is never shown, and who
// created the session isn't either. Ends with the link back to RAWG that
// RAWG's free plan asks for.
export function eventDescription(row) {
  if (!row?.rawg_id) return null;
  const lines = [
    row.genres ? `Genres: ${row.genres}` : null,
    row.platforms ? `Platforms: ${row.platforms}` : null,
    row.coop_modes ? `Co-op: ${row.coop_modes}` : null,
    row.released ? `Released: ${formatReleased(row.released)}` : null,
    row.metacritic ? `Metacritic: ${row.metacritic}` : null,
  ].filter(Boolean);
  const credit = `Game data from RAWG: ${rawgPage(row.rawg_slug)}`;
  let text = [...lines, "", credit].join("\n").trim();
  if (text.length > MAX_EVENT_DESCRIPTION) {
    // Only very long platform/genre lists get here: drop lines from the end of
    // the details until it fits, keeping the credit.
    while (lines.length && [...lines, "", credit].join("\n").length > MAX_EVENT_DESCRIPTION) lines.pop();
    text = [...lines, "", credit].join("\n").trim().slice(0, MAX_EVENT_DESCRIPTION);
  }
  return text;
}

// RAWG serves smaller copies of its images under /media/resize/<width>/-/.
// Discord shows event covers at about 800px wide, so 640px is plenty and much
// smaller to download. Anything not on media.rawg.io is returned unchanged.
export function coverImageUrl(url, width = 640) {
  const m = /^(https:\/\/media\.rawg\.io\/media)\/(games|screenshots)\//.exec(url ?? "");
  if (!m) return url ?? null;
  return url.replace(`${m[1]}/${m[2]}/`, `${m[1]}/resize/${width}/-/${m[2]}/`);
}

// Discord takes JPEG, PNG and GIF for an event cover.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];
// Covers bigger than this are skipped, to keep the Worker's work small.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5000;

// Bytes -> base64, in chunks so big images don't overflow the call stack.
export function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw new Error(`unsupported type "${type}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error("empty image");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`too big (${bytes.length} bytes)`);
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch (err) {
    console.error(`Downloading cover image ${url} failed:`, err.message);
    return null;
  }
}

// The game's RAWG image as Discord "image data" (a data: URI), trying RAWG's
// smaller copy first and then the full-size one. Null if neither works:
// the event is then made without a cover.
export async function fetchCoverImage(imageUrl) {
  if (!imageUrl) return null;
  const small = coverImageUrl(imageUrl);
  return (await downloadImage(small)) ?? (small !== imageUrl ? await downloadImage(imageUrl) : null);
}

// The body for POST /guilds/{id}/scheduled-events: a voice event, no end time.
export function eventBody({ name, unix, channelId, description = null, image = null }) {
  return {
    name,
    channel_id: channelId,
    entity_type: 2, // VOICE
    privacy_level: 2, // GUILD_ONLY, the only option
    scheduled_start_time: new Date(unix * 1000).toISOString(),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
  };
}

// The link Discord shows as an event card when it's posted in a channel.
export const eventLink = (guildId, eventId) => `https://discord.com/events/${guildId}/${eventId}`;

// ---- Posts in the gaming channel (session_posts, migrations/0007) ----

// The title template of the most recent session, so the next one differs.
// Throws if the session_posts table is missing (migration not run yet).
export async function lastTitleTemplate(env) {
  const row = await env.DB.prepare(
    "SELECT title_template FROM session_posts ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).first();
  return row?.title_template ?? null;
}

export async function recordSessionPost(env, { messageId, channelId, eventId, startsAt, titleTemplate, userId }) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO session_posts
       (message_id, channel_id, event_id, starts_at, title_template, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(messageId, channelId, eventId, startsAt, titleTemplate ?? null, userId ?? null, Date.now())
    .run();
}

// Most posts the clean-up deletes in one night. Keeps the nightly run well
// inside Cloudflare's limit on outgoing requests (50 on the free plan), which
// the archive sweep shares. Any left over go the next night.
export const CLEANUP_BATCH = 10;

// Posts still up for sessions that started before `cutoffMs`, oldest first.
export async function postsToRemove(env, cutoffMs, limit = CLEANUP_BATCH) {
  const { results } = await env.DB.prepare(
    `SELECT message_id, channel_id, event_id, starts_at FROM session_posts
     WHERE removed_at IS NULL AND starts_at < ?
     ORDER BY starts_at LIMIT ?`
  )
    .bind(cutoffMs, limit)
    .all();
  return results ?? [];
}

async function markRemoved(env, messageId) {
  await env.DB.prepare("UPDATE session_posts SET removed_at = ? WHERE message_id = ?")
    .bind(Date.now(), messageId)
    .run();
}

// Nightly clean-up: deletes the gaming-channel post of every session that
// started on an earlier day (in TIMEZONE). So a 9pm session on the 27th goes
// at 03:00 on the 28th, and a 1am session on the 28th stays until the night after.
// A post someone already deleted counts as removed. A post Botdog can't delete
// is logged and tried again the next night.
// Returns { removed, failed }.
export async function cleanupSessionPosts(env, now = Date.now()) {
  const cutoff = startOfDayMs(now, env.TIMEZONE || "Europe/London");
  const posts = await postsToRemove(env, cutoff);
  let removed = 0;
  let failed = 0;
  for (const post of posts) {
    try {
      await deleteMessage(env, post.channel_id, post.message_id); // a 404 (already gone) doesn't throw
      await markRemoved(env, post.message_id);
      removed += 1;
    } catch (err) {
      failed += 1;
      console.error(`Deleting session post ${post.message_id} failed:`, err.message);
    }
  }
  if (posts.length) console.log(`Session clean-up: removed ${removed}, failed ${failed}.`);
  return { removed, failed };
}
