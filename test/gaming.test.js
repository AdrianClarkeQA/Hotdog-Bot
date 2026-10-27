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

// Fake Discord for /gaming: the event gets id "event-1", the link post "post-1".
// `override(method, path, body)` can return a response to use instead.
// Later posts get "post-2", "post-3"… like real, unique message ids.
const api = (override = () => null) => {
  let posts = 0;
  return (method, path, body) => {
    const o = override(method, path, body);
    if (o) return o;
    if (method === "POST" && path === "/guilds/guild-1/scheduled-events") return { status: 200, json: { id: "event-1" } };
    if (method === "POST" && path === "/channels/chan-gaming/messages") return { status: 200, json: { id: `post-${++posts}` } };
    return null;
  };
};
const eventCalls = () => discord.calls.filter((c) => c.path === "/guilds/guild-1/scheduled-events");
const linkPosts = () => discord.calls.filter((c) => c.path === "/channels/chan-gaming/messages");
// The answer filled into the "thinking…" reply.
const answer = () => discord.calls.filter((c) => c.path === "/webhooks/app-1/tok-gaming/messages/@original").at(-1)?.body.content;
const LINK = "https://discord.com/events/guild-1/event-1";

test("/gaming creates a voice event, posts its link, and confirms privately", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  const r = await send(env, gamingCommand("Helldivers 2", DATE, "20:00"));

  assert.equal(r.type, 5); // "thinking…"
  assert.equal(r.data.flags, 64); // only the person who ran it sees it

  const [ev] = eventCalls();
  assert.equal(ev.method, "POST");
  assert.equal(ev.body.entity_type, 2); // voice event
  assert.equal(ev.body.channel_id, "chan-voice");
  assert.equal(ev.body.privacy_level, 2);
  assert.equal(ev.body.scheduled_end_time, undefined); // no end time
  assert.match(ev.body.name, /Helldivers 2/);
  assert.ok(Date.parse(ev.body.scheduled_start_time) > Date.now());

  const [post] = linkPosts();
  assert.equal(post.body.content, LINK);
  assert.equal(post.body.flags, undefined); // not suppressed, so Discord shows the event card
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });

  assert.match(answer(), /^Event created for <t:\d+:F> and posted in <#chan-gaming>\.$/);

  // Order: event, then link post, then the answer.
  const order = discord.calls.map((c) => c.path);
  assert.ok(order.indexOf("/guilds/guild-1/scheduled-events") < order.indexOf("/channels/chan-gaming/messages"));

  const row = env.DB.raw.prepare("SELECT * FROM session_posts").get();
  assert.equal(row.message_id, "post-1");
  assert.equal(row.channel_id, "chan-gaming");
  assert.equal(row.event_id, "event-1");
  assert.equal(row.starts_at, Date.parse(ev.body.scheduled_start_time));
  assert.equal(row.removed_at, null);
});

test("/gaming accepts 'tomorrow' and '9pm' end to end", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand("Halo", "tomorrow", "9pm"));
  assert.equal(eventCalls().length, 1);
  assert.ok(Date.parse(eventCalls()[0].body.scheduled_start_time) > Date.now());
  assert.match(answer(), /^Event created/);
});

test("/gaming saves new games and counts repeat uses under one entry", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand("Helldivers 2", DATE, "20:00"));
  await send(env, gamingCommand("  helldivers   2 ", DATE, "21:00"));

  const rows = env.DB.raw.prepare("SELECT name, uses, added_by FROM games").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: "Helldivers 2", uses: 2, added_by: "user-1" }]);
  // The second event uses the saved spelling, not what was typed.
  assert.match(eventCalls()[1].body.name, /Helldivers 2/);
});

test("/gaming never uses the same title twice in a row", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  const realRandom = Math.random;
  Math.random = () => 0; // always the first title still allowed
  try {
    await send(env, gamingCommand("Halo", DATE, "20:00"));
    await send(env, gamingCommand("Halo", DATE, "21:00"));
    await send(env, gamingCommand("Halo", DATE, "22:00"));
  } finally {
    Math.random = realRandom;
  }
  const names = eventCalls().map((c) => c.body.name);
  assert.deepEqual(names, ["Halo gaming", "Halo night", "Halo gaming"]);
});

test("/gaming with no game uses a 'no game' title and saves nothing", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand(undefined, DATE, "20:00"));
  const [ev] = eventCalls();
  assert.ok(["Gaming session", "Game night", "Game night (game TBC)"].includes(ev.body.name));
  assert.equal(ev.body.description, undefined);
  assert.equal(ev.body.image, undefined);
  assert.match(answer(), /^Event created/);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/gaming with a blank game is treated as no game", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand("   ", DATE, "20:00"));
  assert.ok(!eventCalls()[0].body.name.includes("{game}"));
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/gaming bad input replies privately straight away and creates nothing", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  for (const [game, date, time, msg] of [
    ["Halo", "31/02/2027", "20:00", /isn't a real date/],
    [undefined, "31/02/2027", "20:00", /isn't a real date/],
    ["Halo", DATE, "9", /am or pm/],
  ]) {
    const r = await send(env, gamingCommand(game, date, time));
    assert.equal(r.type, 4);
    assert.equal(r.data.flags, 64);
    assert.match(r.data.content, msg);
  }
  assert.equal(discord.calls.length, 0);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
});

test("/gaming with no gaming or voice channel configured warns instead", async () => {
  discord = mockDiscord(api());
  let r = await send(makeEnv({ GAMING_CHANNEL_ID: "" }), gamingCommand("Halo", DATE, "20:00"));
  assert.match(r.data.content, /GAMING_CHANNEL_ID/);
  r = await send(makeEnv({ VOICE_CHANNEL_ID: "" }), gamingCommand("Halo", DATE, "20:00"));
  assert.match(r.data.content, /VOICE_CHANNEL_ID/);
  assert.equal(discord.calls.length, 0);
});

test("/gaming when Botdog can't create events: permission error, nothing posted or saved", async () => {
  const env = makeEnv();
  discord = mockDiscord(
    api((m, p) => (p.endsWith("/scheduled-events") ? { status: 403, json: { message: "Missing Permissions", code: 50013 } } : null))
  );
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(answer(), /doesn't have permission to create events in <#chan-voice>/);
  assert.match(answer(), /Create Events, View Channel and Connect/);
  assert.equal(linkPosts().length, 0);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM games").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM session_posts").get().n, 0);
});

test("/gaming when the voice channel ID is wrong: clear error", async () => {
  const env = makeEnv();
  discord = mockDiscord(api((m, p) => (p.endsWith("/scheduled-events") ? { status: 404, json: { message: "Unknown Channel" } } : null)));
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(answer(), /couldn't find the voice channel set in `VOICE_CHANNEL_ID`/);
  assert.equal(linkPosts().length, 0);
});

test("/gaming when any other event error happens: error with the code", async () => {
  const env = makeEnv();
  discord = mockDiscord(api((m, p) => (p.endsWith("/scheduled-events") ? { status: 400, json: { message: "Invalid Form Body" } } : null)));
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.equal(answer(), "Discord wouldn't create the event (error 400). Nothing was posted.");
});

test("/gaming when the link can't be posted: error includes the event link", async () => {
  const env = makeEnv();
  discord = mockDiscord(api((m, p) => (p === "/channels/chan-gaming/messages" ? { status: 403, json: { message: "Missing Access" } } : null)));
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(answer(), /The event is created, but Botdog couldn't post it in <#chan-gaming>/);
  assert.ok(answer().endsWith(LINK));
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM session_posts").get().n, 0);
});

test("/gaming before the database is updated: asks for the migration, creates nothing", async () => {
  const env = makeEnv();
  env.DB.raw.exec("DROP TABLE session_posts");
  discord = mockDiscord(api());
  await send(env, gamingCommand("Halo", DATE, "20:00"));
  assert.match(answer(), /npm run db:migrate:events/);
  assert.equal(eventCalls().length, 0);
  assert.equal(linkPosts().length, 0);
});

test("/gaming doesn't ping or break on odd game names", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand("*Fortnite* @everyone", DATE, "20:00"));
  // Event names are plain text, so the name goes in as typed.
  assert.match(eventCalls()[0].body.name, /\*Fortnite\* @everyone/);
  assert.deepEqual(linkPosts()[0].body.allowed_mentions, { parse: [] });
  assert.equal(linkPosts()[0].body.content, LINK);
});

test("/gaming works for members without the admin role", async () => {
  const env = makeEnv();
  discord = mockDiscord(api());
  await send(env, gamingCommand("Halo", DATE, "20:00", []));
  assert.match(answer(), /^Event created/);
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
