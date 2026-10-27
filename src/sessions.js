// Pure helpers for /gaming: date/time parsing and game-name tidying.
// No Discord or D1 calls here, so it's easy to test.

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
export function zonedToUtcMs(y, mo, d, h, mi, timeZone) {
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

// Today's date and weekday (0 = Sunday) in the given timezone.
function todayIn(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(nowMs);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const mo = Number(p.month);
  const d = Number(p.day);
  return { y, mo, d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

// Midnight at the start of today in the given timezone, as UTC ms.
// The nightly clean-up removes posts for sessions that started before this.
export function startOfDayMs(now, timeZone) {
  const { y, mo, d } = todayIn(now, timeZone);
  return zonedToUtcMs(y, mo, d, 0, 0, timeZone);
}

// Calendar date `days` after y/mo/d.
function addDays(y, mo, d, days) {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// Words accepted in the date box, all case-insensitive.
const DAY_OFFSETS = { today: 0, tonight: 0, tomorrow: 1, tmrw: 1, tmr: 1, tomoz: 1 };
const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const TIME_HELP = "Try `21:00`, `2100` or `9pm`.";
const DATE_HELP = "Try `tomorrow`, `Saturday` or `25/10/2026`.";

// Reads a time as 24-hour (21:00, 21.00, 2100, 930) or 12-hour (9pm, 9:30pm,
// 930pm, 9 p.m.). Returns { h, mi } or { error }.
export function parseTime(timeStr) {
  const raw = String(timeStr ?? "").trim();
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?m\.?)?$/i.exec(raw);
  if (!m) return { error: `I couldn't read that time. ${TIME_HELP}` };

  let h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  const ampm = m[3]?.toLowerCase();

  if (ampm) {
    if (h < 1 || h > 12 || mi > 59) return { error: `\`${raw}\` isn't a valid time.` };
    if (ampm === "a" && h === 12) h = 0; // 12am = midnight
    if (ampm === "p" && h !== 12) h += 12; // 12pm = midday
  } else {
    // A bare hour like "9" could be morning or evening, so don't guess.
    if (m[2] === undefined) return { error: `Is \`${raw}\` am or pm? ${TIME_HELP}` };
    if (h > 23 || mi > 59) return { error: `\`${raw}\` isn't a valid time.` };
  }
  return { h, mi };
}

// Parses the date and time boxes into Unix seconds, read in the given timezone.
//   date: today / tonight / tomorrow (tmrw, tmr), a weekday (Sat, Saturday),
//         DD/MM/YYYY, or DD/MM for the next occurrence ("/", "-" or "." work)
//   time: see parseTime
// A weekday means the next one; the same weekday as today means today if that
// time is still to come, otherwise a week today.
// Returns { unix } or { error } with a message fit to show the user.
export function parseSessionTime(dateStr, timeStr, { timeZone = "Europe/London", now = Date.now() } = {}) {
  const dateRaw = String(dateStr ?? "").trim();
  const word = dateRaw.toLowerCase();
  const dm = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(dateRaw);
  const isWord = word in DAY_OFFSETS || word in WEEKDAYS;
  if (!dm && !isWord) return { error: `I couldn't read that date. ${DATE_HELP}` };

  const t = parseTime(timeStr);
  if (t.error) return t;
  const { h, mi } = t;

  let ms;
  if (isWord) {
    const today = todayIn(now, timeZone);
    let offset = word in DAY_OFFSETS ? DAY_OFFSETS[word] : (WEEKDAYS[word] - today.dow + 7) % 7;
    let day = addDays(today.y, today.mo, today.d, offset);
    ms = zonedToUtcMs(day.y, day.mo, day.d, h, mi, timeZone);
    if (word in WEEKDAYS && offset === 0 && ms <= now) {
      day = addDays(today.y, today.mo, today.d, 7);
      ms = zonedToUtcMs(day.y, day.mo, day.d, h, mi, timeZone);
    }
  } else {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    const yearGiven = dm[3] !== undefined;
    let y = yearGiven ? Number(dm[3]) : yearIn(now, timeZone);
    if (!isRealDate(y, mo, d)) return { error: `\`${dateRaw}\` isn't a real date.` };

    ms = zonedToUtcMs(y, mo, d, h, mi, timeZone);
    // DD/MM for a date earlier this year means next year (e.g. 05/01 typed in December).
    if (!yearGiven && ms < now - DAY_MS) {
      y += 1;
      if (!isRealDate(y, mo, d)) return { error: `\`${dateRaw}\` isn't a real date next year.` };
      ms = zonedToUtcMs(y, mo, d, h, mi, timeZone);
    }
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
