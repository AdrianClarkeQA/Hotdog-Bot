import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, send, mockDiscord } from "./helpers.js";

let discord;
afterEach(() => discord?.restore());

const QUOTES = "chan-quotes";
const env = () => makeEnv({ QUOTES_CHANNEL_ID: QUOTES });
const member = (id = "user-1") => ({ roles: [], user: { id } });

const quoteCmd = (text, by = "user-1") => ({
  type: 2,
  member: member(by),
  channel_id: "chan-general",
  data: { name: "quote", options: [{ name: "text", type: 3, value: text }] },
});

const pickUser = (customId, userId, { nick, global_name = "Ade C", username = "ade" } = {}, by = "user-1") => ({
  type: 3,
  member: member(by),
  data: {
    custom_id: customId,
    component_type: 5,
    values: [userId],
    resolved: {
      users: { [userId]: { id: userId, username, global_name } },
      members: { [userId]: { nick: nick ?? null } },
    },
  },
});

const click = (customId, by = "user-1") => ({
  type: 3,
  member: member(by),
  data: { custom_id: customId, component_type: 2 },
});

const submitName = (customId, name, by = "user-1") => ({
  type: 5,
  member: member(by),
  data: {
    custom_id: customId,
    components: [{ type: 1, components: [{ type: 4, custom_id: "name", value: name }] }],
  },
});

const quotesCmd = (who) => ({
  type: 2,
  member: member(),
  channel_id: "chan-general",
  data: { name: "quotes", options: [{ name: "who", type: 3, value: who }] },
});

const quotesAuto = (typed) => ({
  type: 4,
  member: member(),
  data: { name: "quotes", options: [{ name: "who", type: 3, value: typed, focused: true }] },
});

const saveAsQuote = (content, author = { id: "user-9", username: "sam", global_name: "Sam" }) => ({
  type: 2,
  member: member(),
  guild_id: "guild-1",
  channel_id: "chan-general",
  data: {
    type: 3,
    name: "Save as quote",
    target_id: "msg-42",
    resolved: { messages: { "msg-42": { id: "msg-42", channel_id: "chan-general", content, author } } },
  },
});

// Pulls the custom_ids off the "who said it?" prompt.
function prompt(r) {
  const [row1, row2] = r.data.components;
  return {
    who: row1.components[0].custom_id,
    name: row2.components[0].custom_id,
    cancel: row2.components[1].custom_id,
  };
}

// Saves a quote via /quote + member picker.
async function saveFor(e, text, userId, names) {
  const ids = prompt(await send(e, quoteCmd(text)));
  return send(e, pickUser(ids.who, userId, names));
}

test("/quote asks who said it privately and posts nothing yet", async () => {
  const e = env();
  discord = mockDiscord();
  const r = await send(e, quoteCmd("I'm not lost, I'm exploring"));

  assert.equal(r.type, 4);
  assert.equal(r.data.flags, 64);
  assert.match(r.data.content, /Who said it\?/);
  assert.equal(r.data.components[0].components[0].type, 5); // member picker
  assert.equal(discord.calls.length, 0);
  assert.equal(e.DB.raw.prepare("SELECT posted FROM quotes").get().posted, 0);
});

test("picking a member posts the quote in quotes, in quotation marks, without pinging", async () => {
  const e = env();
  discord = mockDiscord();
  const r = await saveFor(e, "I'm not lost, I'm exploring", "user-2");

  assert.equal(r.type, 7); // replaces the private prompt
  assert.match(r.data.content, /✅ Quote posted in <#chan-quotes>/);
  assert.deepEqual(r.data.components, []);

  assert.equal(discord.calls.length, 1);
  const { path, body } = discord.calls[0];
  assert.equal(path, `/channels/${QUOTES}/messages`);
  assert.equal(body.content, "💬 “I'm not lost, I'm exploring”\n— <@user-2>");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("someone not in the server: button opens a name box, submitting posts with the name", async () => {
  const e = env();
  discord = mockDiscord();
  const ids = prompt(await send(e, quoteCmd("Respawn is a state of mind")));

  const modal = await send(e, click(ids.name));
  assert.equal(modal.type, 9);
  const input = modal.data.components[0].components[0];
  assert.equal(input.custom_id, "name");

  const r = await send(e, submitName(modal.data.custom_id, "  Uncle   Dave "));
  assert.match(r.data.content, /✅ Quote posted/);
  assert.equal(discord.calls[0].body.content, "💬 “Respawn is a state of mind”\n— **Uncle Dave**");
});

test("double-clicking the picker only posts once", async () => {
  const e = env();
  discord = mockDiscord();
  const ids = prompt(await send(e, quoteCmd("once only")));
  await send(e, pickUser(ids.who, "user-2"));
  const again = await send(e, pickUser(ids.who, "user-3"));
  assert.match(again.data.content, /already been posted/);
  assert.equal(discord.calls.length, 1);
});

test("cancel discards the quote", async () => {
  const e = env();
  discord = mockDiscord();
  const ids = prompt(await send(e, quoteCmd("never mind")));
  const r = await send(e, click(ids.cancel));
  assert.match(r.data.content, /discarded/);
  assert.equal(e.DB.raw.prepare("SELECT count(*) n FROM quotes").get().n, 0);
  assert.equal(discord.calls.length, 0);
});

test("only the person who ran /quote can finish it", async () => {
  const e = env();
  discord = mockDiscord();
  const ids = prompt(await send(e, quoteCmd("mine")));
  const r = await send(e, pickUser(ids.who, "user-2", {}, "user-5"));
  assert.match(r.data.content, /Only the person who ran \/quote/);
  assert.equal(discord.calls.length, 0);
});

test("if posting fails the quote goes back to waiting so it can be retried", async () => {
  const e = env();
  discord = mockDiscord(() => ({ status: 403, json: { message: "Missing Access" } }));
  const ids = prompt(await send(e, quoteCmd("try again")));
  const r = await send(e, pickUser(ids.who, "user-2"));
  assert.match(r.data.content, /Couldn't post/);
  assert.equal(e.DB.raw.prepare("SELECT posted FROM quotes").get().posted, 0);
});

test("markdown and @everyone in quotes show as typed and don't ping", async () => {
  const e = env();
  discord = mockDiscord();
  await saveFor(e, '"*bold* claim @everyone\n# not a heading"', "user-2");
  const { body } = discord.calls[0];
  assert.equal(body.content.split("\n— ")[0], "💬 “\\*bold\\* claim @everyone\n\\# not a heading”");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("/quote with no channel configured warns and saves nothing", async () => {
  const e = makeEnv();
  discord = mockDiscord();
  const r = await send(e, quoteCmd("hello"));
  assert.match(r.data.content, /QUOTES_CHANNEL_ID/);
  assert.equal(e.DB.raw.prepare("SELECT count(*) n FROM quotes").get().n, 0);
});

test("/quotes shows the last 3 quotes, newest first, publicly", async () => {
  const e = env();
  discord = mockDiscord();
  for (const t of ["one", "two", "three", "four"]) await saveFor(e, t, "user-2");
  await saveFor(e, "someone else", "user-3");

  const r = await send(e, quotesCmd("u:user-2"));
  assert.equal(r.type, 4);
  assert.equal(r.data.flags & 64, 0); // everyone sees it
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });
  const c = r.data.content;
  assert.match(c, /^💬 Last 3 quotes from <@user-2>:/);
  assert.ok(c.indexOf("“four”") < c.indexOf("“three”") && c.indexOf("“three”") < c.indexOf("“two”"));
  assert.ok(!c.includes("“one”") && !c.includes("someone else"));
  assert.match(c, /-# <t:\d+:D>/);
});

test("/quotes matches a typed name without picking a suggestion", async () => {
  const e = env();
  discord = mockDiscord();
  const ids = prompt(await send(e, quoteCmd("hi")));
  const modal = await send(e, click(ids.name));
  await send(e, submitName(modal.data.custom_id, "Uncle Dave"));

  const r = await send(e, quotesCmd("uncle dave"));
  assert.match(r.data.content, /^💬 The only quote from \*\*Uncle Dave\*\* so far:/);

  const none = await send(e, quotesCmd("Nobody"));
  assert.match(none.data.content, /No quotes from \*\*Nobody\*\* yet/);
  assert.equal(none.data.flags, 64);
});

test("/quotes suggestions list quoted people, most-quoted first, filtered by typing", async () => {
  const e = env();
  discord = mockDiscord();
  await saveFor(e, "a", "user-2", { global_name: "Ade" });
  await saveFor(e, "b", "user-3", { global_name: "Sam" });
  await saveFor(e, "c", "user-3", { global_name: "Sam" });

  const all = await send(e, quotesAuto(""));
  assert.equal(all.type, 8);
  assert.deepEqual(all.data.choices, [
    { name: "Sam (2 quotes)", value: "u:user-3" },
    { name: "Ade (1 quote)", value: "u:user-2" },
  ]);

  const filtered = await send(e, quotesAuto("ad"));
  assert.deepEqual(filtered.data.choices.map((c) => c.value), ["u:user-2"]);
});

test("Save as quote posts the message straight away, credited to its author, once", async () => {
  const e = env();
  discord = mockDiscord();
  const r = await send(e, saveAsQuote("gg no re"));
  assert.match(r.data.content, /✅ Quote saved/);
  assert.equal(r.data.flags, 64);
  assert.equal(
    discord.calls[0].body.content,
    "💬 “gg no re”\n— <@user-9>\n-# [original message](https://discord.com/channels/guild-1/chan-general/msg-42)"
  );

  const again = await send(e, saveAsQuote("gg no re"));
  assert.match(again.data.content, /already saved/);
  assert.equal(discord.calls.length, 1);

  const list = await send(e, quotesCmd("Sam"));
  assert.match(list.data.content, /<@user-9>/);
});

test("Save as quote on a message with no text says so", async () => {
  const e = env();
  discord = mockDiscord();
  const r = await send(e, saveAsQuote(""));
  assert.match(r.data.content, /no text/);
  assert.equal(discord.calls.length, 0);
});
