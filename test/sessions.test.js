import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionTime, parseTime, gameKey, tidyGameName, escapeMarkdown, startOfDayMs } from "../src/sessions.js";

// Fixed "now": Wed 14 Oct 2026 12:00 BST (11:00 UTC).
const now = Date.UTC(2026, 9, 14, 11, 0);
const parse = (d, t) => parseSessionTime(d, t, { now });
const iso = (r) => new Date(r.unix * 1000).toISOString();

test("summer date is read as BST", () => {
  // The example from the request: 14/10/2026 16:45 UK -> <t:1791992700>
  assert.equal(parse("14/10/2026", "16:45").unix, 1791992700);
});

test("winter date is read as GMT", () => {
  assert.equal(iso(parse("14/12/2026", "20:00")), "2026-12-14T20:00:00.000Z");
});

test("clocks going back: the day itself uses GMT after 02:00", () => {
  assert.equal(iso(parse("25/10/2026", "20:00")), "2026-10-25T20:00:00.000Z");
  assert.equal(iso(parse("24/10/2026", "20:00")), "2026-10-24T19:00:00.000Z");
});

test("clocks going forward next spring uses BST", () => {
  assert.equal(iso(parse("29/03/2027", "20:00")), "2027-03-29T19:00:00.000Z");
});

test("accepts -, . separators, single digits and 20.00", () => {
  assert.equal(iso(parse("5-11-2026", "9:05")), "2026-11-05T09:05:00.000Z");
  assert.equal(iso(parse("05.11.2026", "20.00")), "2026-11-05T20:00:00.000Z");
});

test("DD/MM without a year means the next one", () => {
  assert.equal(iso(parse("20/10", "20:00")), "2026-10-20T19:00:00.000Z");
  assert.equal(iso(parse("05/01", "20:00")), "2027-01-05T20:00:00.000Z");
});

test("rejects past times, including earlier today", () => {
  assert.match(parse("13/10/2026", "20:00").error, /already passed/);
  assert.match(parse("14/10/2026", "11:59").error, /already passed/);
  assert.match(parse("14/10", "09:00").error, /already passed/);
});

test("rejects nonsense and impossible dates/times", () => {
  assert.match(parse("31/02/2027", "20:00").error, /isn't a real date/);
  assert.match(parse("29/02/2027", "20:00").error, /isn't a real date/);
  assert.match(parse("someday", "20:00").error, /couldn't read that date/);
  assert.match(parse("next week", "20:00").error, /couldn't read that date/);
  assert.match(parse("10/14/2026", "20:00").error, /isn't a real date/); // US order
  assert.match(parse("20/10/2026", "eight").error, /couldn't read that time/);
  assert.match(parse("20/10/2026", "13pm").error, /isn't a valid time/);
  assert.match(parse("20/10/2026", "2160").error, /isn't a valid time/);
  assert.match(parse("20/10/2026", "24:00").error, /isn't a valid time/);
  assert.match(parse("20/10/2026", "20:60").error, /isn't a valid time/);
});

test("today, tonight and tomorrow (and short forms) use the UK calendar date", () => {
  assert.equal(iso(parse("today", "20:00")), "2026-10-14T19:00:00.000Z");
  assert.equal(iso(parse("Tonight", "21:00")), "2026-10-14T20:00:00.000Z");
  assert.equal(iso(parse("tomorrow", "20:00")), "2026-10-15T19:00:00.000Z");
  assert.equal(iso(parse(" TMRW ", "20:00")), "2026-10-15T19:00:00.000Z");
  assert.equal(iso(parse("tmr", "20:00")), "2026-10-15T19:00:00.000Z");
  assert.match(parse("today", "09:00").error, /already passed/);
});

test("just after midnight UK time, 'tomorrow' is the next UK day, not the UTC one", () => {
  // Thu 15 Oct 2026 00:30 BST is still Wed 14 Oct in UTC.
  const lateNight = Date.UTC(2026, 9, 14, 23, 30);
  const r = parseSessionTime("tomorrow", "21:00", { now: lateNight });
  assert.equal(iso(r), "2026-10-16T20:00:00.000Z");
});

test("weekday names mean the next one (from Thu 15 Oct, Saturday is 17/10/2026)", () => {
  const thu = Date.UTC(2026, 9, 15, 0, 13); // Thu 15 Oct 2026 01:13 BST
  const p = (d, t) => iso(parseSessionTime(d, t, { now: thu }));
  assert.equal(p("Saturday", "21:00"), "2026-10-17T20:00:00.000Z");
  assert.equal(p("sat", "2100"), "2026-10-17T20:00:00.000Z");
  assert.equal(p("SATURDAY", "9pm"), "2026-10-17T20:00:00.000Z");
  assert.equal(p("fri", "20:00"), "2026-10-16T19:00:00.000Z");
  assert.equal(p("sun", "20:00"), "2026-10-18T19:00:00.000Z");
  assert.equal(p("wed", "20:00"), "2026-10-21T19:00:00.000Z");
});

test("today's weekday means today if the time is still to come, else a week today", () => {
  // now is Wed 14 Oct 12:00 BST
  assert.equal(iso(parse("Wednesday", "20:00")), "2026-10-14T19:00:00.000Z");
  assert.equal(iso(parse("weds", "09:00")), "2026-10-21T08:00:00.000Z");
});

test("weekday across the clocks going back uses GMT", () => {
  assert.equal(iso(parse("tue", "20:00")), "2026-10-20T19:00:00.000Z");
  const fri23 = Date.UTC(2026, 9, 23, 11, 0); // Fri 23 Oct
  assert.equal(iso(parseSessionTime("sun", "20:00", { now: fri23 })), "2026-10-25T20:00:00.000Z");
});

test("times: colon optional, dot allowed, 12-hour with am/pm", () => {
  const cases = {
    "21:00": [21, 0], "2100": [21, 0], "21.00": [21, 0], "9:05": [9, 5], "0930": [9, 30],
    "930": [9, 30], "100": [1, 0], "0000": [0, 0],
    "9pm": [21, 0], "9PM": [21, 0], "9 pm": [21, 0], "9p.m.": [21, 0], "9:30pm": [21, 30],
    "930pm": [21, 30], "9.30pm": [21, 30], "9am": [9, 0], "12pm": [12, 0], "12am": [0, 0],
    "12:30am": [0, 30],
  };
  for (const [input, [h, mi]] of Object.entries(cases)) {
    assert.deepEqual(parseTime(input), { h, mi }, input);
  }
});

test("times: bare hours ask am or pm; nonsense is rejected", () => {
  assert.match(parseTime("9").error, /am or pm/);
  assert.match(parseTime("21").error, /am or pm/);
  assert.match(parseTime("0pm").error, /isn't a valid time/);
  assert.match(parseTime("12:60pm").error, /isn't a valid time/);
  assert.match(parseTime("24:00").error, /isn't a valid time/);
  assert.match(parseTime("21:5").error, /couldn't read/);
  assert.match(parseTime("21000").error, /couldn't read/);
  assert.match(parseTime("").error, /couldn't read/);
});

test("2100 and 9pm give the same session as 21:00", () => {
  const a = parse("20/10/2026", "21:00").unix;
  assert.equal(parse("20/10/2026", "2100").unix, a);
  assert.equal(parse("20/10/2026", "9pm").unix, a);
});

test("rejects dates more than a year ahead (typo guard)", () => {
  assert.match(parse("20/10/2062", "20:00").error, /more than a year away/);
  assert.ok(parse("13/10/2027", "20:00").unix);
});

test("game names: spacing tidied, case-insensitive key", () => {
  assert.equal(tidyGameName("  Helldivers   2 "), "Helldivers 2");
  assert.equal(gameKey("helldivers 2"), gameKey(" Helldivers  2"));
});

test("markdown in game names is escaped so bold isn't broken", () => {
  assert.equal(escapeMarkdown("*Fortnite*"), "\\*Fortnite\\*");
  assert.equal(escapeMarkdown("Halo_2 ~|`\\"), "Halo\\_2 \\~\\|\\`\\\\");
});

test("startOfDayMs is UK midnight, in both GMT and BST", () => {
  // 03:00 GMT on 28 Oct 2026 (clocks went back on the 25th) -> midnight GMT.
  assert.equal(startOfDayMs(Date.UTC(2026, 9, 28, 3, 0), "Europe/London"), Date.UTC(2026, 9, 28, 0, 0));
  // 03:00 UTC on 1 Jul 2026 is 04:00 BST -> midnight BST is 23:00 UTC the day before.
  assert.equal(startOfDayMs(Date.UTC(2026, 6, 1, 3, 0), "Europe/London"), Date.UTC(2026, 5, 30, 23, 0));
});
