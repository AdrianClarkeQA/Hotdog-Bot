// Pure helpers for /gaming: date/time parsing, game-name tidying, and the
// announcement text. No Discord or D1 calls here, so it's easy to test.

const DAY_MS = 24 * 60 * 60 * 1000;

// Longest game name accepted. Matches Discord's 100-character limit on
// autocomplete choices, so every saved game can be offered back.
export const MAX_GAME_LEN = 100;

// How far ahead a session can be planned. Catches typos like 2062.
export const MAX_AHEAD_DAYS = 366;

// Offset (ms) between UTC and the given timezone at a UTC instant.
function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

// Wall-clock time in a timezone -> UTC ms. Two passes so times either side of
// a clock change land on the right offset.
function zonedToUtcMs(y, mo, d, h, mi, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - tzOffsetMs(naive, timeZone);
  return naive - tzOffsetMs(first, timeZone);
}

// Current year in the given timezone.
function yearIn(nowMs, timeZone) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" }).format(nowMs));
}

function isRealDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Parses a UK-style date and 24h time into Unix seconds.
//   date: DD/MM/YYYY, or DD/MM for the next occurrence ("/", "-" or "." work)
//   time: HH:MM or H:MM, 24-hour (":" or ".")
// Returns { unix } or { error } with a message fit to show the user.
export function parseSessionTime(dateStr, timeStr, { timeZone = "Europe/London", now = Date.now() } = {}) {
  const dm = /^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?\s*$/.exec(dateStr ?? "");
  if (!dm) return { error: "I couldn't read that date. Use DD/MM/YYYY, e.g. `25/10/2026`." };
  const tm = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(timeStr ?? "");
  if (!tm) return { error: "I couldn't read that time. Use 24-hour HH:MM, e.g. `20:00`." };

  const d = Number(dm[1]);
  const mo = Number(dm[2]);
  const h = Number(tm[1]);
  const mi = Number(tm[2]);
  if (h > 23 || mi > 59) return { error: `\`${timeStr.trim()}\` isn't a valid time.` };

  const yearGiven = dm[3] !== undefined;
  let y = yearGiven ? Number(dm[3]) : yearIn(now, timeZone);
  if (!isRealDate(y, mo, d)) return { error: `\`${dateStr.trim()}\` isn't a real date.` };

  let ms = zonedToUtcMs(y, mo, d, h, mi, timeZone);
  // DD/MM for a date earlier this year means next year (e.g. 05/01 typed in December).
  if (!yearGiven && ms < now - DAY_MS) {
    y += 1;
    if (!isRealDate(y, mo, d)) return { error: `\`${dateStr.trim()}\` isn't a real date next year.` };
    ms = zonedToUtcMs(y, mo, d, h, mi, timeZone);
  }

  if (ms <= now) return { error: "That time has already passed — pick a time in the future." };
  if (ms - now > MAX_AHEAD_DAYS * DAY_MS) {
    return { error: "That's more than a year away. Check the date and try again." };
  }
  return { unix: Math.floor(ms / 1000) };
}

// Trims and collapses whitespace in a game name as typed.
export function tidyGameName(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

// Key used to treat "Helldivers 2", "helldivers 2" and "Helldivers  2 " as one game.
export function gameKey(raw) {
  return tidyGameName(raw).normalize("NFKC").toLowerCase();
}

// Escapes characters that would break Discord formatting inside **bold**.
export function escapeMarkdown(text) {
  return String(text).replace(/([\\*_~`|])/g, "\\$1");
}

// The announcement posted in the gaming channel.
export function sessionMessage({ game, unix, userId }) {
  return (
    `🎮 **${escapeMarkdown(game)}** session planned for <t:${unix}:F> (<t:${unix}:R>)` +
    (userId ? `\nSuggested by <@${userId}>` : "")
  );
}
