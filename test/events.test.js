import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, mockDiscord } from "./helpers.js";
import {
  GAME_TITLES,
  NO_GAME_TITLES,
  MAX_EVENT_NAME,
  fillTitle,
  pickTitle,
  eventDescription,
  coverImageUrl,
  toBase64,
  eventBody,
  eventLink,
  cleanupSessionPosts,
  CLEANUP_BATCH,
} from "../src/events.js";
import { runNightly } from "../src/index.js";

let discord;
afterEach(() => discord?.restore());

// ---- Titles ----

test("titles: every game title names the game, and none ask a question", () => {
  for (const t of GAME_TITLES) {
    assert.ok(t.includes("{game}"), t);
    assert.ok(!t.includes("?"), t);
  }
  for (const t of NO_GAME_TITLES) {
    assert.ok(!t.includes("{game}"), t);
    assert.ok(!t.includes("?"), t);
  }
  assert.ok(!GAME_TITLES.includes("{game}, anyone?"));
});

test("fillTitle puts the game in, and shortens long names to fit 100 characters", () => {
  assert.equal(fillTitle("Squad up: {game}", "Helldivers 2"), "Squad up: Helldivers 2");
  const long = "A".repeat(100);
  for (const t of GAME_TITLES) {
    const name = fillTitle(t, long);
    assert.ok(name.length <= MAX_EVENT_NAME, `${t} -> ${name.length}`);
    assert.ok(name.includes("…"));
  }
  assert.equal(fillTitle("Game night"), "Game night");
});

test("pickTitle never repeats the previous template, whatever the dice say", () => {
  for (const r of [0, 0.3, 0.5, 0.99]) {
    for (const last of GAME_TITLES) {
      const { template } = pickTitle("Halo", { last, random: () => r });
      assert.notEqual(template, last);
      assert.ok(GAME_TITLES.includes(template));
    }
  }
  const { template, name } = pickTitle("", { random: () => 0.99 });
  assert.ok(NO_GAME_TITLES.includes(template));
  assert.equal(name, template);
});

test("pickTitle uses every title over time", () => {
  const seen = new Set();
  for (let i = 0; i < GAME_TITLES.length; i++) {
    seen.add(pickTitle("Halo", { random: () => i / GAME_TITLES.length }).template);
  }
  assert.equal(seen.size, GAME_TITLES.length);
});

// ---- Description and cover ----

const ROW = {
  name: "Deep Rock Galactic",
  rawg_id: 9551,
  rawg_slug: "deep-rock-galactic",
  genres: "Indie, Action",
  platforms: "PC, PlayStation, Xbox",
  coop_modes: "Online co-op",
  released: "2020-05-13",
  metacritic: 84,
  playtime: 7,
};

test("eventDescription: RAWG details and credit, never playtime or who made it", () => {
  const d = eventDescription(ROW);
  assert.match(d, /^Genres: Indie, Action\nPlatforms: PC, PlayStation, Xbox\nCo-op: Online co-op\nReleased: 13 May 2020\nMetacritic: 84\n\nGame data from RAWG: https:\/\/rawg\.io\/games\/deep-rock-galactic$/);
  assert.ok(!/playtime|7 hours|created|<@/i.test(d));
});

test("eventDescription: leaves out what RAWG doesn't have; null with no match", () => {
  assert.equal(
    eventDescription({ rawg_id: 1, rawg_slug: "x", metacritic: null, genres: "Action" }),
    "Genres: Action\n\nGame data from RAWG: https://rawg.io/games/x"
  );
  assert.equal(eventDescription({ name: "Homebrew", rawg_id: null }), null);
  assert.equal(eventDescription(null), null);
});

test("eventDescription stays inside Discord's 1000 characters", () => {
  const d = eventDescription({ ...ROW, platforms: "PC, ".repeat(400), genres: "Action, ".repeat(200) });
  assert.ok(d.length <= 1000);
  assert.ok(d.endsWith("Game data from RAWG: https://rawg.io/games/deep-rock-galactic"));
});

test("coverImageUrl asks RAWG for its 640px copy; other links are left alone", () => {
  assert.equal(
    coverImageUrl("https://media.rawg.io/media/games/c92/drg.jpg"),
    "https://media.rawg.io/media/resize/640/-/games/c92/drg.jpg"
  );
  assert.equal(
    coverImageUrl("https://media.rawg.io/media/screenshots/35d/extra.jpg"),
    "https://media.rawg.io/media/resize/640/-/screenshots/35d/extra.jpg"
  );
  assert.equal(coverImageUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
  assert.equal(coverImageUrl(null), null);
});

test("toBase64 matches Node's encoder, including for big images", () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 7) % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("eventBody is a voice event with no end time", () => {
  const body = eventBody({ name: "Halo night", unix: 1793232000, channelId: "chan-voice" });
  assert.deepEqual(body, {
    name: "Halo night",
    channel_id: "chan-voice",
    entity_type: 2,
    privacy_level: 2,
    scheduled_start_time: "2026-10-29T00:00:00.000Z",
  });
  assert.equal(eventLink("g", "e"), "https://discord.com/events/g/e");
});

// ---- Nightly clean-up ----

const UK = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi); // Oct/Nov 2026 is GMT, so UK = UTC

function addPost(env, id, startsAt, removedAt = null) {
  env.DB.raw
    .prepare(
      `INSERT INTO session_posts (message_id, channel_id, event_id, starts_at, created_at, removed_at)
       VALUES (?, 'chan-gaming', ?, ?, ?, ?)`
    )
    .run(id, `event-${id}`, startsAt, startsAt - 86400000, removedAt);
}
const stillUp = (env) =>
  env.DB.raw
    .prepare("SELECT message_id FROM session_posts WHERE removed_at IS NULL ORDER BY message_id")
    .all()
    .map((r) => r.message_id);
const deletes = () => discord.calls.filter((c) => c.method === "DELETE").map((c) => c.path);

test("clean-up: a 9pm session on the 27th is removed at 03:00 on the 28th", async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 200 }));
  addPost(env, "p-9pm", UK(2026, 10, 27, 21));
  const r = await cleanupSessionPosts(env, UK(2026, 10, 28, 3));
  assert.deepEqual(r, { removed: 1, failed: 0 });
  assert.deepEqual(deletes(), ["/channels/chan-gaming/messages/p-9pm"]);
  assert.deepEqual(stillUp(env), []);
});

test("clean-up: sessions later the same night, or still to come, are kept", async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 200 }));
  addPost(env, "p-1am", UK(2026, 10, 28, 1)); // after midnight: the 28th's session
  addPost(env, "p-tonight", UK(2026, 10, 28, 21));
  addPost(env, "p-next-week", UK(2026, 11, 4, 20));

  await cleanupSessionPosts(env, UK(2026, 10, 28, 3));
  assert.deepEqual(deletes(), []);

  // The next night, the 1am and 9pm sessions on the 28th go.
  await cleanupSessionPosts(env, UK(2026, 10, 29, 3));
  assert.deepEqual(deletes(), ["/channels/chan-gaming/messages/p-1am", "/channels/chan-gaming/messages/p-tonight"]);
  assert.deepEqual(stillUp(env), ["p-next-week"]);
});

test("clean-up uses UK dates in summer time too", async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 200 }));
  // 23:30 BST on 1 Jul is 22:30 UTC; 00:30 BST on 2 Jul is 23:30 UTC on 1 Jul.
  addPost(env, "p-late", Date.UTC(2026, 6, 1, 22, 30));
  addPost(env, "p-after-midnight", Date.UTC(2026, 6, 1, 23, 30));
  // Cron fires at 03:00 UTC = 04:00 BST on 2 Jul.
  await cleanupSessionPosts(env, Date.UTC(2026, 6, 2, 3, 0));
  assert.deepEqual(stillUp(env), ["p-after-midnight"]);
});

test("clean-up: a post someone already deleted counts as removed; posts already removed are skipped", async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 404, json: { message: "Unknown Message" } }));
  addPost(env, "p-gone", UK(2026, 10, 20, 21));
  addPost(env, "p-done", UK(2026, 10, 19, 21), UK(2026, 10, 20, 3));
  const r = await cleanupSessionPosts(env, UK(2026, 10, 28, 3));
  assert.deepEqual(r, { removed: 1, failed: 0 });
  assert.deepEqual(deletes(), ["/channels/chan-gaming/messages/p-gone"]);
  assert.deepEqual(stillUp(env), []);
});

test("clean-up: a post Botdog can't delete is kept and tried again the next night", async () => {
  const env = makeEnv();
  let allowed = false;
  discord = mockDiscord(() => (allowed ? { status: 200 } : { status: 403, json: { message: "Missing Access" } }));
  addPost(env, "p-1", UK(2026, 10, 27, 21));
  assert.deepEqual(await cleanupSessionPosts(env, UK(2026, 10, 28, 3)), { removed: 0, failed: 1 });
  assert.deepEqual(stillUp(env), ["p-1"]);
  allowed = true;
  assert.deepEqual(await cleanupSessionPosts(env, UK(2026, 10, 29, 3)), { removed: 1, failed: 0 });
});

test(`clean-up deletes at most ${CLEANUP_BATCH} posts a night, oldest first`, async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 200 }));
  for (let i = 0; i < CLEANUP_BATCH + 3; i++) addPost(env, `p-${String(i).padStart(2, "0")}`, UK(2026, 10, 1 + i, 21));
  await cleanupSessionPosts(env, UK(2026, 10, 28, 3));
  assert.equal(deletes().length, CLEANUP_BATCH);
  assert.equal(deletes()[0], "/channels/chan-gaming/messages/p-00");
  assert.deepEqual(stillUp(env), ["p-10", "p-11", "p-12"]);
});

test("nightly run: clean-up still happens when the archive sweep fails", async () => {
  const env = makeEnv();
  discord = mockDiscord((method, path) =>
    path === "/guilds/guild-1/channels" ? { status: 500, json: { message: "Discord is down" } } : { status: 200 }
  );
  addPost(env, "p-old", Date.now() - 3 * 86400000);
  await runNightly(env);
  assert.ok(discord.calls.some((c) => c.path === "/guilds/guild-1/channels"));
  assert.deepEqual(deletes(), ["/channels/chan-gaming/messages/p-old"]);
});

test("nightly run: a database without session_posts doesn't break the sweep", async () => {
  const env = makeEnv();
  env.DB.raw.exec("DROP TABLE session_posts");
  discord = mockDiscord((method, path) => (path === "/guilds/guild-1/channels" ? { status: 200, json: [] } : null));
  await runNightly(env); // must not throw
  assert.ok(discord.calls.some((c) => c.path === "/guilds/guild-1/channels"));
});
