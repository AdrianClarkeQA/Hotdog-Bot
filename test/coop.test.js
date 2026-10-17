import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, send, mockDiscord, gamingCommand, gamingAutocomplete } from "./helpers.js";
import { pickRandom, coopListMessage } from "../src/coop.js";

let discord;
afterEach(() => discord?.restore());

const member = { roles: [], user: { id: "user-1" } };

const coopSet = (game, status) => ({
  type: 2,
  member,
  data: {
    name: "coop",
    options: [
      {
        name: "set",
        type: 1,
        options: [
          { name: "game", type: 3, value: game },
          { name: "status", type: 3, value: status },
        ],
      },
    ],
  },
});

const coopSub = (name, options = []) => ({
  type: 2,
  member,
  data: { name: "coop", options: [{ name, type: 1, options }] },
});

const coopAutocomplete = (typed) => ({
  type: 4,
  member,
  data: {
    name: "coop",
    options: [{ name: "set", type: 1, options: [{ name: "game", type: 3, value: typed, focused: true }] }],
  },
});

const statusOf = (env, name) =>
  env.DB.raw.prepare("SELECT coop_status FROM games WHERE name = ?").get(name)?.coop_status;

const future = new Date(Date.now() + 3 * 86400000);
const DATE = `${future.getUTCDate()}/${future.getUTCMonth() + 1}/${future.getUTCFullYear()}`;

test("/coop set adds a new game with its status, privately confirmed", async () => {
  const env = makeEnv();
  const r = await send(env, coopSet("Helldivers 2", "ready"));
  assert.equal(r.data.flags, 64);
  assert.equal(r.data.content, "**Helldivers 2** added to the co-op list as ✅ Ready.");
  const row = env.DB.raw.prepare("SELECT name, uses, coop_status, added_by FROM games").get();
  assert.deepEqual({ ...row }, { name: "Helldivers 2", uses: 0, coop_status: "ready", added_by: "user-1" });
});

test("/coop set changes status and shows old → new, keeping the saved spelling", async () => {
  const env = makeEnv();
  await send(env, coopSet("Helldivers 2", "ready"));
  const r = await send(env, coopSet("  helldivers   2 ", "parked"));
  assert.equal(r.data.content, "**Helldivers 2**: ✅ Ready → 🅿️ Parked");
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 1);
  assert.equal(statusOf(env, "Helldivers 2"), "parked");
});

test("/coop set to the same status says so", async () => {
  const env = makeEnv();
  await send(env, coopSet("Halo", "completed"));
  const r = await send(env, coopSet("Halo", "completed"));
  assert.equal(r.data.content, "**Halo** is already 🏆 Completed It Mate.");
});

test("/coop set rejects an unknown status and saves nothing", async () => {
  const env = makeEnv();
  const r = await send(env, coopSet("Halo", "finished"));
  assert.match(r.data.content, /Pick a status/);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/coop and /gaming share one game list both ways", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  // A game first posted with /gaming can be given a status...
  await send(env, gamingCommand("Deep Rock Galactic", DATE, "20:00"));
  await send(env, coopSet("deep rock galactic", "ready"));
  const row = env.DB.raw.prepare("SELECT name, uses, coop_status FROM games").get();
  assert.deepEqual({ ...row }, { name: "Deep Rock Galactic", uses: 1, coop_status: "ready" });

  // ...and a game added with /coop is suggested by /gaming.
  await send(env, coopSet("Lethal Company", "not_purchased"));
  const r = await send(env, gamingAutocomplete("lethal company"));
  assert.deepEqual(r.data.choices, [{ name: "Lethal Company", value: "Lethal Company" }]);
});

test("/coop set autocomplete shows statuses and offers new games", async () => {
  const env = makeEnv();
  await send(env, coopSet("Helldivers 2", "parked"));
  const r = await send(env, coopAutocomplete("helldivers 2"));
  assert.deepEqual(r.data.choices, [{ name: "Helldivers 2 · Parked", value: "Helldivers 2" }]);

  const n = await send(env, coopAutocomplete("Valheim"));
  assert.deepEqual(n.data.choices, [{ name: "➕ New game: Valheim", value: "Valheim" }]);
});

test("/coop recommend picks only Ready games and posts publicly without pings", async () => {
  const env = makeEnv();
  await send(env, coopSet("Helldivers 2", "ready"));
  await send(env, coopSet("Halo", "parked"));
  await send(env, coopSet("Portal 2", "completed"));
  await send(env, coopSet("Lethal Company", "not_purchased"));

  for (let i = 0; i < 10; i++) {
    const r = await send(env, coopSub("recommend"));
    assert.equal(r.data.flags, 4); // public, not ephemeral
    assert.deepEqual(r.data.allowed_mentions, { parse: [] });
    assert.equal(r.data.content, "🎲 Co-op pick: **Helldivers 2** (the only Ready game)");
  }
});

test("/coop recommend with several Ready games says how many it picked from", async () => {
  const env = makeEnv();
  await send(env, coopSet("Helldivers 2", "ready"));
  await send(env, coopSet("Valheim", "ready"));
  const r = await send(env, coopSub("recommend"));
  assert.match(r.data.content, /^🎲 Co-op pick: \*\*(Helldivers 2|Valheim)\*\* \(picked from 2 Ready games\)$/);
});

test("/coop recommend with nothing Ready replies privately", async () => {
  const env = makeEnv();
  await send(env, coopSet("Halo", "parked"));
  const r = await send(env, coopSub("recommend"));
  assert.equal(r.data.flags, 64);
  assert.match(r.data.content, /No games are marked ✅ Ready/);
});

test("pickRandom covers every item", () => {
  const items = ["a", "b", "c"];
  assert.equal(pickRandom(items, () => 0), "a");
  assert.equal(pickRandom(items, () => 0.5), "b");
  assert.equal(pickRandom(items, () => 0.999), "c");
  assert.equal(pickRandom([]), null);
});

test("/coop list groups by status in order, skips empty groups, ignores games with no status", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  await send(env, gamingCommand("Fortnite", DATE, "20:00")); // no co-op status
  await send(env, coopSet("Valheim", "ready"));
  await send(env, coopSet("Helldivers 2", "ready"));
  await send(env, coopSet("Portal 2", "completed"));

  const r = await send(env, coopSub("list"));
  assert.equal(r.data.flags, 64);
  assert.equal(
    r.data.content,
    "**✅ Ready** (2)\n• Helldivers 2\n• Valheim\n\n**🏆 Completed It Mate** (1)\n• Portal 2"
  );
});

test("/coop list filtered by status", async () => {
  const env = makeEnv();
  await send(env, coopSet("Valheim", "ready"));
  const r = await send(env, coopSub("list", [{ name: "status", type: 3, value: "parked" }]));
  assert.equal(r.data.content, "**🅿️ Parked** (0)\n_None yet_");
});

test("/coop list when empty", async () => {
  const env = makeEnv();
  const r = await send(env, coopSub("list"));
  assert.match(r.data.content, /co-op list is empty/);
});

test("coopListMessage stays under Discord's 2000-character limit", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    name: `A Very Long Co-op Game Name Number ${i}`,
    coop_status: "ready",
  }));
  const text = coopListMessage(rows);
  assert.ok(text.length <= 2000);
  assert.match(text, /…and \d+ more$/);
});

test("/games remove still works on a game with a co-op status", async () => {
  const env = makeEnv();
  await send(env, coopSet("Halo", "ready"));
  const r = await send(env, {
    type: 2,
    member: { roles: ["role-admin"], user: { id: "user-1" } },
    data: { name: "games", options: [{ name: "remove", type: 1, options: [{ name: "game", type: 3, value: "halo" }] }] },
  });
  assert.match(r.data.content, /Removed \*\*Halo\*\*/);
  const rec = await send(env, coopSub("recommend"));
  assert.match(rec.data.content, /No games are marked/);
});
