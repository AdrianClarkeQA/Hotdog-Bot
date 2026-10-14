// Test harness: runs the real Worker fetch() against an in-memory SQLite
// database (standing in for D1) and a mocked Discord REST API.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import worker from "../src/index.js";

// Minimal D1 lookalike: prepare().bind().first()/all()/run().
export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => db.prepare(sql).run(...args),
    };
    return stmt;
  };
  return { prepare, raw: db };
}

// Ed25519 key pair so requests pass the Worker's signature check.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

export const ADMIN_ROLE = "role-admin";

export function makeEnv(overrides = {}) {
  return {
    DB: makeDb(),
    DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
    DISCORD_TOKEN: "test-token",
    GUILD_ID: "guild-1",
    ARCHIVE_CATEGORY_ID: "cat-archive",
    PRIVILEGED_ROLE_ID: ADMIN_ROLE,
    DEFAULT_DAYS: "30",
    GAMING_CHANNEL_ID: "chan-gaming",
    TIMEZONE: "Europe/London",
    ...overrides,
  };
}

// Sends a signed interaction through the Worker; returns the parsed JSON reply.
export async function send(env, interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const res = await worker.fetch(
    new Request("https://worker.test/", {
      method: "POST",
      headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      body,
    }),
    env
  );
  return res.json();
}

// Replaces global fetch with a fake Discord API. Records every call.
// `handler(method, path, body)` may return { status, json } to override.
export function mockDiscord(handler = () => null) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/api/v10", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const r = handler(init.method, path, body) ?? { status: 200, json: { id: "msg-1" } };
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

// Builders for the interaction payloads Discord sends.
const member = (roles = []) => ({ roles, user: { id: "user-1" } });

export const gamingCommand = (game, date, time, roles) => ({
  type: 2,
  member: member(roles),
  channel_id: "chan-general",
  data: {
    name: "gaming",
    options: [
      { name: "game", type: 3, value: game },
      { name: "date", type: 3, value: date },
      { name: "time", type: 3, value: time },
    ],
  },
});

export const gamingAutocomplete = (typed) => ({
  type: 4,
  member: member(),
  data: {
    name: "gaming",
    options: [{ name: "game", type: 3, value: typed, focused: true }],
  },
});

export const gamesRemove = (game, roles = [ADMIN_ROLE]) => ({
  type: 2,
  member: member(roles),
  data: { name: "games", options: [{ name: "remove", type: 1, options: [{ name: "game", type: 3, value: game }] }] },
});

export const gamesRemoveAutocomplete = (typed) => ({
  type: 4,
  member: member([ADMIN_ROLE]),
  data: {
    name: "games",
    options: [{ name: "remove", type: 1, options: [{ name: "game", type: 3, value: typed, focused: true }] }],
  },
});
