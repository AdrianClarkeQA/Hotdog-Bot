import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, send, mockDiscord, gamingCommand, ADMIN_ROLE } from "./helpers.js";
import { pickResult, summarise, coopModes, slugFromLink, normaliseName } from "../src/rawg.js";
import { formatReleased, shortDescription, statsText, sessionEmbed, infoEmbed } from "../src/game-info.js";
import { coopLine, coopListMessage } from "../src/coop.js";

// ---- Fixtures shaped like real RAWG responses ----

const DRG = {
  id: 9551,
  slug: "deep-rock-galactic",
  name: "Deep Rock Galactic",
  released: "2020-05-13",
  tba: false,
  background_image: "https://media.rawg.io/media/games/c92/drg.jpg",
  rating: 4.1,
  ratings_count: 690,
  metacritic: 84,
  playtime: 7,
  added: 9000,
  parent_platforms: [{ platform: { name: "PC" } }, { platform: { name: "PlayStation" } }, { platform: { name: "Xbox" } }],
  platforms: [{ platform: { name: "PC" } }, { platform: { name: "PlayStation 5" } }],
  genres: [{ name: "Indie" }, { name: "Action" }],
  tags: [
    { name: "Singleplayer", slug: "singleplayer" },
    { name: "Co-op", slug: "co-op" },
    { name: "Online Co-Op", slug: "online-co-op" },
  ],
  esrb_rating: { name: "Teen" },
};

const DRG_DETAIL = {
  ...DRG,
  description_raw: "A first-person co-op shooter for up to 4 players. You play as space dwarves. ".repeat(8),
  stores: [{ url: "", store: { name: "Steam", slug: "steam" } }],
  background_image_additional: "https://media.rawg.io/media/screenshots/35d/extra.jpg",
};

const result = (name, added, extra = {}) => ({ id: added, slug: normaliseName(name).replace(/ /g, "-"), name, added, ...extra });

// ---- Matching ----

test("pickResult takes a popular exact match regardless of case and punctuation", () => {
  const results = [result("HELLDIVERS 2", 948), result("Helldivers II", 346), result("HELLDIVERS", 3460)];
  assert.equal(pickResult("helldivers 2", results).name, "HELLDIVERS 2");
});

test("pickResult skips an obscure exact match for the popular series game", () => {
  // Real RAWG results for "halo": the exact match is a tiny itch.io game.
  const results = [result("Halo (itch)", 21), result("Halo", 3), result("Halo Infinite", 7889), result("Halo: Reach", 3065)];
  assert.equal(pickResult("Halo", results).name, "Halo Infinite");
});

test("pickResult falls back to an unpopular exact match when nothing else fits", () => {
  assert.equal(pickResult("Tiny Indie", [result("Tiny Indie", 4), result("Something Else", 900)]).name, "Tiny Indie");
});

test("pickResult returns null when nothing is a convincing match", () => {
  assert.equal(pickResult("Made Up Game", [result("Starfox 2", 55), result("Q.U.B.E. 2", 1663)]), null);
  assert.equal(pickResult("", [result("Halo", 500)]), null);
  assert.equal(pickResult("Halo", undefined), null);
});

// ---- Reading RAWG data ----

test("summarise keeps the fields Botdog saves, using broad platform names", () => {
  assert.deepEqual(summarise(DRG), {
    rawg_id: 9551,
    rawg_slug: "deep-rock-galactic",
    rawg_name: "Deep Rock Galactic",
    image_url: "https://media.rawg.io/media/games/c92/drg.jpg",
    metacritic: 84,
    rawg_rating: 4.1,
    rawg_ratings_count: 690,
    released: "2020-05-13",
    playtime: 7,
    genres: "Indie, Action",
    platforms: "PC, PlayStation, Xbox",
    coop_modes: "Online co-op",
  });
});

test("summarise turns RAWG's gaps into blanks rather than zeros", () => {
  const s = summarise({ id: 1, name: "New Game", metacritic: null, rating: 0, ratings_count: 0, playtime: 0, tba: true });
  assert.equal(s.metacritic, null);
  assert.equal(s.rawg_rating, null);
  assert.equal(s.playtime, null);
  assert.equal(s.released, "TBA");
  assert.equal(s.coop_modes, null);
  assert.equal(summarise(null), null);
});

test("coopModes lists specific co-op tags, or plain Co-op if that's all there is", () => {
  assert.deepEqual(coopModes([{ slug: "local-co-op" }, { slug: "online-co-op" }]), ["Online co-op", "Local co-op"]);
  assert.deepEqual(coopModes([{ slug: "cooperative" }]), ["Co-op"]);
  assert.deepEqual(coopModes([{ slug: "singleplayer" }]), []);
});

test("slugFromLink reads RAWG page links and bare slugs", () => {
  assert.equal(slugFromLink("https://rawg.io/games/deep-rock-galactic"), "deep-rock-galactic");
  assert.equal(slugFromLink("rawg.io/games/Halo-Reach?foo=1"), "halo-reach");
  assert.equal(slugFromLink("  helldivers-2 "), "helldivers-2");
  assert.equal(slugFromLink("https://example.com/not a game"), null);
});

// ---- Formatting ----

test("formatReleased, statsText and shortDescription", () => {
  assert.equal(formatReleased("2020-05-13"), "13 May 2020");
  assert.equal(formatReleased("TBA"), "TBA");
  assert.equal(statsText({ metacritic: 84, playtime: 18 }), "*Metacritic 84*");
  assert.equal(statsText({ metacritic: null, playtime: 18 }), "");
  assert.equal(statsText({}), "");
  const short = shortDescription(DRG_DETAIL.description_raw);
  assert.ok(short.length <= 350);
  assert.ok(short.endsWith("."));
});

test("co-op list lines show Metacritic in italics, no playtime, and credit RAWG only when there's data", () => {
  assert.equal(coopLine({ name: "Deep Rock Galactic", metacritic: 84, playtime: 7 }), "• Deep Rock Galactic · *Metacritic 84*");
  assert.equal(coopLine({ name: "Unknown" }), "• Unknown");

  const withData = coopListMessage([{ name: "DRG", coop_status: "ready", metacritic: 84, playtime: 7 }]);
  assert.match(withData, /Game data from \[RAWG\]\(<https:\/\/rawg\.io>\)$/);
  const without = coopListMessage([{ name: "DRG", coop_status: "ready" }]);
  assert.doesNotMatch(without, /RAWG/);
});

test("session and info embeds link to RAWG and leave out what RAWG doesn't have", () => {
  const row = { name: "drg", ...summarise(DRG) };
  const e = sessionEmbed(row);
  assert.equal(e.title, "Deep Rock Galactic");
  assert.equal(e.url, "https://rawg.io/games/deep-rock-galactic");
  assert.equal(e.description, "Metacritic 84 · Online co-op · 7h avg playtime");
  assert.equal(e.footer.text, "Data from RAWG");
  assert.equal(sessionEmbed({ name: "x", rawg_id: null }), null);

  const info = infoEmbed({ ...summarise(DRG), metacritic: null, stores: "Steam", age_rating: "Teen" }, "Ready");
  const fields = Object.fromEntries(info.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Metacritic, undefined); // no score: no empty field
  assert.equal(fields["RAWG rating"], "4.1 / 5 (690)");
  assert.equal(fields.Released, "13 May 2020");
  assert.equal(fields["Avg playtime"], "7 hours");
  assert.equal(fields["On our co-op list"], "Ready");
});

// ---- End to end through the Worker ----

let discord;
let rawgCalls;
afterEach(() => discord?.restore());

// Fakes Discord (via mockDiscord) and RAWG together. `rawg(path, params)`
// returns the JSON for a RAWG request, or null for a 404.
function mockBoth(rawg, discordHandler) {
  discord = mockDiscord(discordHandler);
  rawgCalls = [];
  const fakeDiscord = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== "api.rawg.io") return fakeDiscord(url, init);
    assert.equal(u.searchParams.get("key"), "test-rawg-key");
    const params = Object.fromEntries(u.searchParams);
    rawgCalls.push({ path: u.pathname, params });
    const body = rawg(u.pathname.replace("/api", ""), params);
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  };
}

const drgRawg = (path) => {
  if (path === "/games") return { results: [DRG] };
  if (path === "/games/9551" || path === "/games/deep-rock-galactic") return DRG_DETAIL;
  return null;
};

const gamesCommand = (sub, options = [], roles = []) => ({
  type: 2,
  application_id: "app-1",
  token: "tok-1",
  member: { roles, user: { id: "user-1" } },
  data: { name: "games", options: [{ name: sub, type: 1, options }] },
});
const gameOpt = (value) => ({ name: "game", type: 3, value });

const future = new Date(Date.now() + 3 * 86400000);
const DATE = `${future.getUTCDate()}/${future.getUTCMonth() + 1}/${future.getUTCFullYear()}`;

test("/gaming with a new game posts first, then adds RAWG details to the post", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(drgRawg);
  const r = await send(env, gamingCommand("deep rock galactic", DATE, "20:00"));
  assert.match(r.data.content, /^✅ Posted/);

  const [post, edit] = discord.calls;
  assert.equal(post.path, "/channels/chan-gaming/messages");
  assert.equal(post.body.flags, 4); // nothing known yet: no details box
  assert.equal(edit.method, "PATCH");
  assert.equal(edit.path, "/channels/chan-gaming/messages/msg-1");
  assert.equal(edit.body.flags, 0);
  assert.equal(edit.body.embeds[0].description, "Metacritic 84 · Online co-op · 7h avg playtime");

  const saved = env.DB.raw.prepare("SELECT rawg_id, metacritic, rawg_checked_at FROM games").get();
  assert.equal(saved.rawg_id, 9551);
  assert.equal(saved.metacritic, 84);
  assert.ok(saved.rawg_checked_at);

  // Second session: details go straight into the post, no new RAWG lookup.
  rawgCalls.length = 0;
  discord.calls.length = 0;
  await send(env, gamingCommand("Deep Rock Galactic", DATE, "21:00"));
  assert.equal(rawgCalls.length, 0);
  assert.equal(discord.calls.length, 1);
  assert.equal(discord.calls[0].body.flags, undefined);
  assert.equal(discord.calls[0].body.embeds[0].title, "Deep Rock Galactic");
});

test("/gaming doesn't retry RAWG for a game it couldn't find", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(() => ({ results: [] }));
  await send(env, gamingCommand("Our Homebrew Game", DATE, "20:00"));
  assert.equal(rawgCalls.length, 1);
  assert.equal(discord.calls.length, 1); // posted, no edit
  await send(env, gamingCommand("Our Homebrew Game", DATE, "21:00"));
  assert.equal(rawgCalls.length, 1);
});

test("/gaming still posts when RAWG is down", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(() => {
    throw new Error("network down");
  });
  const r = await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(r.data.content, /^✅ Posted/);
  assert.equal(discord.calls.length, 1);
});

test("/games info answers 'thinking', then fills in the details card", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(drgRawg);
  // Saved and on the co-op list, but not looked up yet.
  env.DB.raw.exec("INSERT INTO games (name_key, name, uses, last_used, added_at, coop_status) VALUES ('deep rock galactic', 'Deep Rock Galactic', 0, 0, 0, 'ready')");

  const r = await send(env, gamesCommand("info", [gameOpt("Deep Rock Galactic")]));
  assert.equal(r.type, 5); // deferred
  assert.deepEqual(r.data, {}); // public

  assert.deepEqual(rawgCalls.map((c) => c.path), ["/api/games", "/api/games/9551"]);
  const answer = discord.calls.at(-1);
  assert.equal(answer.method, "PATCH");
  assert.equal(answer.path, "/webhooks/app-1/tok-1/messages/@original");
  const card = answer.body.embeds[0];
  const fields = Object.fromEntries(card.fields.map((f) => [f.name, f.value]));
  assert.equal(card.url, "https://rawg.io/games/deep-rock-galactic");
  assert.equal(fields.Metacritic, "84");
  assert.equal(fields["Where to buy"], "Steam");
  assert.equal(fields["Age rating"], "Teen");
  assert.equal(fields["On our co-op list"], "Ready");
  assert.equal(card.image.url, DRG.background_image);

  // The saved game now has its details.
  assert.equal(env.DB.raw.prepare("SELECT rawg_id FROM games").get().rawg_id, 9551);
});

test("/games info works for games that aren't saved, without saving them", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(drgRawg);
  await send(env, gamesCommand("info", [gameOpt("Deep Rock Galactic")]));
  assert.equal(discord.calls.at(-1).body.embeds[0].title, "Deep Rock Galactic");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM games").get().n, 0);
});

test("/games info says when RAWG has no match, and when the key isn't set", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key" });
  mockBoth(() => ({ results: [] }));
  await send(env, gamesCommand("info", [gameOpt("Made Up Game")]));
  assert.match(discord.calls.at(-1).body.content, /^Couldn't find \*\*Made Up Game\*\* on RAWG/);

  const noKey = await send(makeEnv(), gamesCommand("info", [gameOpt("Halo")]));
  assert.equal(noKey.type, 4);
  assert.equal(noKey.data.flags, 64);
  assert.match(noKey.data.content, /RAWG_API_KEY/);
});

test("/games link is admin only and re-points a saved game at the right RAWG game", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key", COOP_CHANNEL_ID: "chan-coop" });
  mockBoth(drgRawg);
  env.DB.raw.exec("INSERT INTO games (name_key, name, uses, last_used, added_at, coop_status, rawg_id) VALUES ('drg', 'DRG', 0, 0, 0, 'ready', 1)");
  const link = [gameOpt("DRG"), { name: "rawg", type: 3, value: "https://rawg.io/games/deep-rock-galactic" }];

  const denied = await send(env, gamesCommand("link", link));
  assert.match(denied.data.content, /permission/);

  const r = await send(env, gamesCommand("link", link, [ADMIN_ROLE]));
  assert.equal(r.type, 5);
  assert.equal(r.data.flags, 64);
  assert.deepEqual(rawgCalls.map((c) => c.path), ["/api/games/deep-rock-galactic"]);
  assert.equal(env.DB.raw.prepare("SELECT rawg_id FROM games").get().rawg_id, 9551);

  // It's on the co-op list, so the list post is refreshed with the new details.
  const board = discord.calls.find((c) => c.path === "/channels/chan-coop/messages");
  assert.match(board.body.content, /• DRG · \*Metacritic 84\*$/m);
  assert.match(discord.calls.at(-1).body.content, /now uses RAWG's \*\*Deep Rock Galactic\*\*/);
});

test("/games refresh looks up unmatched games and reports the misses", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key", COOP_CHANNEL_ID: "chan-coop" });
  mockBoth((path, params) => (path === "/games" && params.search === "Deep Rock Galactic" ? { results: [DRG] } : { results: [] }));
  env.DB.raw.exec(`INSERT INTO games (name_key, name, uses, last_used, added_at, coop_status) VALUES
    ('deep rock galactic', 'Deep Rock Galactic', 0, 0, 0, 'ready'),
    ('homebrew', 'Homebrew', 0, 0, 0, NULL)`);

  const r = await send(env, gamesCommand("refresh", [], [ADMIN_ROLE]));
  assert.equal(r.type, 5);
  const report = discord.calls.at(-1).body.content;
  assert.match(report, /^Found RAWG details for 1 of 2 games\./);
  assert.match(report, /Not found: \*\*Homebrew\*\*/);
  assert.ok(discord.calls.some((c) => c.path === "/channels/chan-coop/messages"));
});

test("/coop set looks a new game up before updating the list post", async () => {
  const env = makeEnv({ RAWG_API_KEY: "test-rawg-key", COOP_CHANNEL_ID: "chan-coop" });
  mockBoth(drgRawg);
  await send(env, {
    type: 2,
    member: { roles: [], user: { id: "user-1" } },
    data: {
      name: "coop",
      options: [{ name: "set", type: 1, options: [gameOpt("Deep Rock Galactic"), { name: "status", type: 3, value: "ready" }] }],
    },
  });
  const board = discord.calls.find((c) => c.path === "/channels/chan-coop/messages");
  assert.match(board.body.content, /• Deep Rock Galactic · \*Metacritic 84\*$/m);
  assert.match(board.body.content, /Game data from \[RAWG\]/);
});
