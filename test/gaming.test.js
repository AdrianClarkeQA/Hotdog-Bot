import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  makeEnv,
  send,
  mockDiscord,
  gamingCommand,
  gamingAutocomplete,
  gamesRemove,
  gamesRemoveAutocomplete,
} from "./helpers.js";

let discord;
afterEach(() => discord?.restore());

// A date that's always in the future relative to when the tests run.
const future = new Date(Date.now() + 3 * 86400000);
const DATE = `${future.getUTCDate()}/${future.getUTCMonth() + 1}/${future.getUTCFullYear()}`;

const names = (r) => r.data.choices.map((c) => c.name);

test("/gaming posts in the gaming channel with bold game and timestamps, no pings", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  const r = await send(env, gamingCommand("Helldivers 2", DATE, "20:00"));

  assert.equal(r.type, 4);
  assert.equal(r.data.flags, 64); // confirmation only visible to the poster
  assert.equal(r.data.content, "✅ Posted in <#chan-gaming>.");

  assert.equal(discord.calls.length, 1);
  const { method, path, body } = discord.calls[0];
  assert.equal(method, "POST");
  assert.equal(path, "/channels/chan-gaming/messages");
  assert.match(body.content, /^🎮 \*\*Helldivers 2\*\* session planned for <t:(\d+):F> \(<t:\1:R>\)\nCreated by <@user-1>$/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("/gaming saves new games and counts repeat uses under one entry", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  await send(env, gamingCommand("Helldivers 2", DATE, "20:00"));
  await send(env, gamingCommand("  helldivers   2 ", DATE, "21:00"));

  const rows = env.DB.raw.prepare("SELECT name, uses, added_by FROM games").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: "Helldivers 2", uses: 2, added_by: "user-1" }]);
  // The second post uses the saved spelling, not what was typed.
  assert.match(discord.calls[1].body.content, /\*\*Helldivers 2\*\*/);
});

test("/gaming escapes markdown and doesn't ping @everyone in game names", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  await send(env, gamingCommand("*Fortnite* @everyone", DATE, "20:00"));
  const { body } = discord.calls[0];
  assert.match(body.content, /\*\*\\\*Fortnite\\\* @everyone\*\*/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("/gaming bad input replies privately and posts nothing", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  const r = await send(env, gamingCommand("Halo", "31/02/2027", "20:00"));
  assert.match(r.data.content, /isn't a real date/);
  assert.equal(r.data.flags, 64);
  assert.equal(discord.calls.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/gaming with no channel configured warns instead of posting", async () => {
  const env = makeEnv({ GAMING_CHANNEL_ID: "" });
  discord = mockDiscord();
  const r = await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(r.data.content, /GAMING_CHANNEL_ID/);
  assert.equal(discord.calls.length, 0);
});

test("/gaming when Discord refuses the post: clear error, game not saved", async () => {
  const env = makeEnv();
  discord = mockDiscord(() => ({ status: 403, json: { message: "Missing Access" } }));
  const r = await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(r.data.content, /Couldn't post in <#chan-gaming>/);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/gaming works for members without the admin role", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  const r = await send(env, gamingCommand("Halo", DATE, "20:00", []));
  assert.equal(r.data.content, "✅ Posted in <#chan-gaming>.");
});

test("autocomplete: empty box lists most-used games first", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  for (const g of ["Halo", "Helldivers 2", "Helldivers 2", "Minecraft", "Minecraft", "Minecraft"]) {
    await send(env, gamingCommand(g, DATE, "20:00"));
  }
  const r = await send(env, gamingAutocomplete(""));
  assert.equal(r.type, 8);
  assert.deepEqual(names(r), ["Minecraft", "Helldivers 2", "Halo"]);
});

test("autocomplete: prefix matches first, then contains, plus a 'new game' option", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  for (const g of ["Shell Shock", "Helldivers 2", "Halo"]) await send(env, gamingCommand(g, DATE, "20:00"));

  const r = await send(env, gamingAutocomplete("hel"));
  assert.deepEqual(names(r), ["Helldivers 2", "Shell Shock", "➕ New game: hel"]);
  assert.equal(r.data.choices.at(-1).value, "hel");
});

test("autocomplete: no 'new game' option when the typed name is already saved", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  const r = await send(env, gamingAutocomplete("HALO"));
  assert.deepEqual(names(r), ["Halo"]);
});

test("autocomplete: never more than 25 choices, new-game option kept", async () => {
  const env = makeEnv();
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    env.DB.raw
      .prepare("INSERT INTO games (name_key, name, uses, last_used, added_at) VALUES (?, ?, 1, ?, ?)")
      .run(`game ${i}`, `Game ${i}`, now, now);
  }
  const r = await send(env, gamingAutocomplete("game"));
  assert.equal(r.data.choices.length, 25);
  assert.equal(r.data.choices.at(-1).name, "➕ New game: game");
});

test("autocomplete: % and _ in names are matched literally", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  for (const g of ["100% Orange Juice", "Halo_2", "Halo"]) await send(env, gamingCommand(g, DATE, "20:00"));
  assert.deepEqual(names(await send(env, gamingAutocomplete("0%"))), ["100% Orange Juice", "➕ New game: 0%"]);
  assert.deepEqual(names(await send(env, gamingAutocomplete("o_"))), ["Halo_2", "➕ New game: o_"]);
});

test("/games remove: admin only, autocomplete offers no 'new game'", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  await send(env, gamingCommand("Halo 3", DATE, "20:00"));

  assert.deepEqual(names(await send(env, gamesRemoveAutocomplete("halo"))), ["Halo", "Halo 3"]);
  assert.deepEqual(names(await send(env, gamesRemoveAutocomplete("zelda"))), []);

  const denied = await send(env, gamesRemove("Halo", []));
  assert.match(denied.data.content, /don't have permission/);

  const ok = await send(env, gamesRemove("halo"));
  assert.equal(ok.data.content, "🗑️ Removed **Halo** from the game list.");
  assert.deepEqual(names(await send(env, gamesRemoveAutocomplete(""))), ["Halo 3"]);

  const missing = await send(env, gamesRemove("Halo"));
  assert.equal(missing.data.content, "That game isn't in the list.");
});

test("/arc still routes to the archiver (PR #3 behaviour untouched)", async () => {
  const env = makeEnv();
  discord = mockDiscord();
  const r = await send(env, {
    type: 2,
    member: { roles: [], user: { id: "user-1" } },
    data: { name: "arc", options: [{ name: "status", type: 1 }] },
  });
  assert.match(r.data.content, /don't have permission/);
});
