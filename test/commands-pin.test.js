import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fillVersion,
  splitIntoMessages,
  isMajorOrMinorBump,
  postCommandList,
  MARKER,
  MAX_LENGTH,
} from "../scripts/post-commands-pin.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("major and minor bumps post; patch bumps and re-runs don't", () => {
  assert.equal(isMajorOrMinorBump("v1.7.0", "1.8.0"), true);
  assert.equal(isMajorOrMinorBump("v1.7.3", "1.8.0"), true);
  assert.equal(isMajorOrMinorBump("v1.9.0", "2.0.0"), true);
  assert.equal(isMajorOrMinorBump("v1.10.0", "1.11.0"), true);
  assert.equal(isMajorOrMinorBump("v1.7.0", "1.7.1"), false);
  assert.equal(isMajorOrMinorBump("v1.8.0", "1.8.0"), false);
  assert.equal(isMajorOrMinorBump("", "1.0.0"), true);
});

test("the real command list fills in the version and fits Discord's limit", async () => {
  const template = await readFile(new URL("../docs/commands-pin.md", import.meta.url), "utf8");
  const text = fillVersion(template, "1.8.0");
  assert.ok(text.startsWith(`${MARKER}** - current version: v1.8.0`));
  assert.ok(!text.includes("{{VERSION}}"));

  const messages = splitIntoMessages(text);
  for (const m of messages) {
    assert.ok(m.length <= MAX_LENGTH, `message is ${m.length} chars`);
    assert.ok(m.startsWith(MARKER));
  }
  // Nothing lost or duplicated: every command line appears exactly once.
  const commandLines = text.split("\n").filter((l) => l.startsWith("`"));
  for (const line of commandLines) {
    assert.equal(messages.join("\n").split(line).length - 1, 1, line);
  }
});

test("a long list splits between version sections, never inside one", () => {
  const section = (n) =>
    `**v1.${n} - Thing ${n}**\n----------\n\`/cmd${n}\` - ${"x".repeat(80)}`;
  const text = [`${MARKER}** - current version: v1.9.0`, ...[1, 2, 3, 4, 5].map(section)].join("\n\n");

  const messages = splitIntoMessages(text, 300);
  assert.ok(messages.length > 1);
  assert.ok(messages[0].startsWith(`${MARKER}** - current version`));
  for (const m of messages.slice(1)) assert.ok(m.startsWith(`${MARKER} (continued)**`));
  for (const m of messages) {
    assert.ok(m.length <= 300);
    // Each section's heading and its command stay in the same message.
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(m.includes(`**v1.${n} - `), m.includes(`/cmd${n}\``));
    }
  }
});

test("a short list stays as one message", () => {
  assert.deepEqual(splitIntoMessages("hello"), ["hello"]);
});

// Fake Discord: channel holds messages, pins tracked separately.
function fakeDiscord({ messages = [], pins = [], oldPinsEndpointOnly = false } = {}) {
  const calls = [];
  let nextId = 900;
  globalThis.fetch = async (url, { method, body }) => {
    const path = url.replace("https://discord.com/api/v10", "");
    calls.push(`${method} ${path}`);
    const ok = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status });
    if (path === "/users/@me") return ok({ id: "bot" });
    if (path.endsWith("/messages/pins?limit=50")) {
      if (oldPinsEndpointOnly) return ok({ message: "404" }, 404);
      return ok({ items: messages.filter((m) => pins.includes(m.id)).map((message) => ({ message })), has_more: false });
    }
    if (path.endsWith("/pins") && method === "GET") return ok(messages.filter((m) => pins.includes(m.id)));
    if (path.includes("/messages?limit=100")) {
      const before = new URL(`https://x${path}`).searchParams.get("before");
      const newestFirst = [...messages].reverse().filter((m) => !before || Number(m.id) < Number(before));
      return ok(newestFirst.slice(0, 100));
    }
    if (method === "POST") {
      const msg = { id: String(nextId++), author: { id: "bot" }, ...JSON.parse(body) };
      messages.push(msg);
      return ok(msg);
    }
    if (method === "DELETE") {
      const id = path.split("/").pop();
      messages.splice(messages.findIndex((m) => m.id === id), 1);
      if (pins.includes(id)) pins.splice(pins.indexOf(id), 1);
      return ok(null, 204);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { calls, messages, pins };
}

test("posts the new list, then deletes only Botdog's old list, and pins nothing", async () => {
  const fake = fakeDiscord({
    messages: [
      { id: "1", author: { id: "bot" }, content: `${MARKER}** - current version: v1.7.0` },
      { id: "2", author: { id: "bot" }, content: `${MARKER} (continued)**\n\nold part 2` },
      { id: "3", author: { id: "someone" }, content: `${MARKER}** fake list by a person` },
      { id: "4", author: { id: "bot" }, content: "Some other Botdog post" },
    ],
    pins: ["1", "3"],
  });

  const result = await postCommandList({ token: "t", channelId: "c", messages: ["new 1", "new 2"] });

  assert.deepEqual(result.deleted.sort(), ["1", "2"]);
  assert.deepEqual(fake.messages.map((m) => m.id), ["3", "4", "900", "901"]);
  // Old pinned list gone with its message; the person's pin untouched; nothing new pinned.
  assert.deepEqual(fake.pins, ["3"]);
  assert.ok(!fake.calls.some((c) => c.startsWith("PUT")));
  // New list posted before anything was deleted.
  const firstDelete = fake.calls.findIndex((c) => c.startsWith("DELETE"));
  const lastPost = fake.calls.findLastIndex((c) => c.startsWith("POST"));
  assert.ok(lastPost < firstDelete);
});

test("posts never ping anyone", async () => {
  let sent;
  fakeDiscord();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === "POST") sent = JSON.parse(opts.body);
    return fetch(url, opts);
  };
  await postCommandList({ token: "t", channelId: "c", messages: ["@everyone hi"] });
  assert.deepEqual(sent.allowed_mentions, { parse: [] });
});

test("finds an old pinned list through the older pins endpoint when the new one isn't available", async () => {
  const fake = fakeDiscord({
    messages: [{ id: "1", author: { id: "bot" }, content: `${MARKER}** old` }],
    pins: ["1"],
    oldPinsEndpointOnly: true,
  });
  const { deleted } = await postCommandList({ token: "t", channelId: "c", messages: ["new"] });
  assert.deepEqual(deleted, ["1"]);
  assert.ok(fake.calls.includes("GET /channels/c/pins"));
});

test("finds an old list further back than the last 100 messages", async () => {
  const chatter = Array.from({ length: 250 }, (_, i) => ({
    id: String(i + 2),
    author: { id: "someone" },
    content: "chat",
  }));
  const fake = fakeDiscord({
    messages: [{ id: "1", author: { id: "bot" }, content: `${MARKER}** old` }, ...chatter],
  });
  const { deleted } = await postCommandList({ token: "t", channelId: "c", messages: ["new"] });
  assert.deepEqual(deleted, ["1"]);
  assert.ok(!fake.messages.some((m) => m.id === "1"));
});

test("if posting fails, the old list is left alone", async () => {
  const fake = fakeDiscord({
    messages: [{ id: "1", author: { id: "bot" }, content: `${MARKER}** old` }],
    pins: ["1"],
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) =>
    opts.method === "POST" ? new Response("Missing Permissions", { status: 403 }) : fetch(url, opts);

  await assert.rejects(postCommandList({ token: "t", channelId: "c", messages: ["new"] }), /403/);
  assert.deepEqual(fake.messages.map((m) => m.id), ["1"]);
  assert.deepEqual(fake.pins, ["1"]);
});
