import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionTime, gameKey, tidyGameName, escapeMarkdown, sessionMessage } from "../src/sessions.js";

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
  assert.match(parse("tomorrow", "20:00").error, /couldn't read that date/);
  assert.match(parse("10/14/2026", "20:00").error, /isn't a real date/); // US order
  assert.match(parse("20/10/2026", "8pm").error, /couldn't read that time/);
  assert.match(parse("20/10/2026", "24:00").error, /isn't a valid time/);
  assert.match(parse("20/10/2026", "20:60").error, /isn't a valid time/);
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

test("announcement text", () => {
  assert.equal(
    sessionMessage({ game: "Helldivers 2", unix: 1791992700, userId: "42" }),
    "🎮 **Helldivers 2** session planned for <t:1791992700:F> (<t:1791992700:R>)\nCreated by <@42>"
  );
});
