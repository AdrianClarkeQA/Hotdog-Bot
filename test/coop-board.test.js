import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, send, mockDiscord, ADMIN_ROLE } from "./helpers.js";
import { refreshCoopBoard, coopBoardMessage } from "../src/coop.js";

let discord;
afterEach(() => discord?.restore());

const member = (roles = []) => ({ roles, user: { id: "user-1" } });

const coopSet = (game, status) => ({
  type: 2,
  member: member(),
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

// Fake Discord where each new message gets a larger id, like real snowflakes.
function discordWithIds(start = 1000) {
  let next = start;
  return mockDiscord((method) => (method === "POST" ? { status: 200, json: { id: String(next++) } } : null));
}

const posts = () => discord.calls.filter((c) => c.method === "POST");
const deletes = () => discord.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
const stored = (env) =>
  env.DB.raw.prepare("SELECT message_id FROM coop_board_posts").all().map((r) => r.message_id);

const ENV = { COOP_CHANNEL_ID: "chan-coop" };

test("a status change posts the full list in the co-op channel, without pings", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready"));
  await send(env, coopSet("Halo", "parked"));

  const last = posts().at(-1);
  assert.equal(last.path, "/channels/chan-coop/messages");
  assert.deepEqual(last.body.allowed_mentions, { parse: [] });
  assert.match(
    last.body.content,
    /^\*\*Co-op games\*\*\nLast change: \*\*Halo\*\* added as Parked, by <@user-1> \(<t:\d+:R>\)\n\n\*\*Ready\*\* \(1\)\n• Valheim\n\n\*\*Parked\*\* \(1\)\n• Halo$/
  );
});

test("each new post deletes the previous one, leaving only the latest", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready")); // posts 1000
  await send(env, coopSet("Valheim", "parked")); // posts 1001, deletes 1000
  await send(env, coopSet("Valheim", "completed")); // posts 1002, deletes 1001

  assert.equal(posts().length, 3);
  assert.deepEqual(deletes(), [
    "/channels/chan-coop/messages/1000",
    "/channels/chan-coop/messages/1001",
  ]);
  assert.deepEqual(stored(env), ["1002"]);
  assert.match(posts().at(-1).body.content, /Last change: \*\*Valheim\*\*: Parked → Completed It Mate/);
});

test("the new list is posted before the old one is deleted", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready"));
  await send(env, coopSet("Valheim", "parked"));
  const order = discord.calls.map((c) => c.method);
  assert.deepEqual(order, ["POST", "POST", "DELETE"]);
});

test("no change, no new post", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready"));
  const r = await send(env, coopSet("Valheim", "ready"));
  assert.match(r.data.content, /already Ready/);
  assert.equal(posts().length, 1);
});

test("an old post someone already deleted by hand doesn't break anything", async () => {
  const env = makeEnv(ENV);
  let next = 1000;
  discord = mockDiscord((method) =>
    method === "POST" ? { status: 200, json: { id: String(next++) } } : { status: 404, json: {} }
  );
  await send(env, coopSet("Valheim", "ready"));
  const r = await send(env, coopSet("Valheim", "parked"));
  assert.match(r.data.content, /Ready → Parked/);
  assert.deepEqual(stored(env), ["1001"]);
});

test("if posting fails, the old list stays and the status still saves", async () => {
  const env = makeEnv(ENV);
  let fail = false;
  let next = 1000;
  discord = mockDiscord((method) => {
    if (method !== "POST") return null;
    return fail ? { status: 403, json: { message: "Missing Access" } } : { status: 200, json: { id: String(next++) } };
  });
  await send(env, coopSet("Valheim", "ready"));
  fail = true;
  const r = await send(env, coopSet("Valheim", "parked"));

  assert.match(r.data.content, /Ready → Parked/);
  assert.equal(env.DB.raw.prepare("SELECT coop_status FROM games").get().coop_status, "parked");
  assert.deepEqual(deletes(), []);
  assert.deepEqual(stored(env), ["1000"]);
});

test("two changes at once still end with exactly one post: the newest", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready"));
  await send(env, coopSet("Halo", "ready"));
  await Promise.all([refreshCoopBoard(env, "a"), refreshCoopBoard(env, "b")]);
  assert.deepEqual(stored(env), ["1003"]);
});

test("with no co-op channel set, nothing is posted", async () => {
  const env = makeEnv();
  discord = discordWithIds();
  const r = await send(env, coopSet("Valheim", "ready"));
  assert.match(r.data.content, /added to the co-op list/);
  assert.equal(discord.calls.length, 0);
});

test("/games remove of a co-op game updates the post; of a non-co-op game, doesn't", async () => {
  const env = makeEnv(ENV);
  discord = discordWithIds();
  await send(env, coopSet("Valheim", "ready"));
  env.DB.raw.exec("INSERT INTO games (name_key, name, uses, last_used, added_at) VALUES ('fortnite', 'Fortnite', 1, 1, 1)");

  const remove = (game) => ({
    type: 2,
    member: member([ADMIN_ROLE]),
    data: { name: "games", options: [{ name: "remove", type: 1, options: [{ name: "game", type: 3, value: game }] }] },
  });

  await send(env, remove("Fortnite"));
  assert.equal(posts().length, 1);

  await send(env, remove("Valheim"));
  assert.equal(posts().length, 2);
  assert.match(posts().at(-1).body.content, /Last change: \*\*Valheim\*\* removed/);
  assert.match(posts().at(-1).body.content, /co-op list is empty/);
});

test("the post stays under Discord's 2000-character limit", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    name: `A Very Long Co-op Game Name Number ${i}`,
    coop_status: "ready",
  }));
  const text = coopBoardMessage(rows, { change: "**X** added as Ready, by <@123456789012345678>", unix: 1 });
  assert.ok(text.length <= 2000, `length ${text.length}`);
  assert.match(text, /…and \d+ more$/);
});

test("if the post-tracking table is missing, nothing is posted", async () => {
  const env = makeEnv(ENV);
  env.DB.raw.exec("DROP TABLE coop_board_posts");
  discord = discordWithIds();
  const r = await send(env, coopSet("Valheim", "ready"));
  assert.match(r.data.content, /added to the co-op list/);
  assert.equal(discord.calls.length, 0);
});
