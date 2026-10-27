// Posts the command list (docs/commands-pin.md) in the commands channel,
// then deletes Botdog's previous command list. Nothing is pinned.
//
// Run by the deploy workflow after a major or minor release. Can also be run by
// hand:  node scripts/post-commands-pin.js
// Requires env vars: DISCORD_TOKEN, COMMANDS_CHANNEL_ID
// Optional: DRY_RUN=1 prints what would be posted without calling Discord.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";
export const MAX_LENGTH = 2000;
// Every command list message starts with this, so old ones can be found.
export const MARKER = "**Botdog commands";
const DIVIDER = /^-{3,}$/;

// ---------- pure helpers (tested in test/commands-pin.test.js) ----------

// Also turns Windows line endings (\r\n, which Git can give the file on a
// Windows checkout) into plain \n, so the section dividers are recognised.
export function fillVersion(template, version) {
  return template.replace(/\r\n?/g, "\n").replaceAll("{{VERSION}}", version).trim();
}

// Splits the list into messages of at most `max` characters. Splits only
// between version sections (each section is a heading line with a divider
// line under it), and starts every extra message with a "(continued)" heading.
export function splitIntoMessages(text, max = MAX_LENGTH) {
  text = text.replace(/\r\n?/g, "\n");
  if (text.length <= max) return [text];

  const lines = text.split("\n");
  const sections = [];
  let current = [];
  for (let i = 0; i < lines.length; i++) {
    // A section begins at a heading: a non-divider line with a divider directly under it.
    const startsSection =
      !DIVIDER.test(lines[i]) && DIVIDER.test(lines[i + 1] ?? "") && current.length > 0;
    if (startsSection) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(lines[i]);
  }
  sections.push(current.join("\n").trim());

  const continued = `${MARKER} (continued)**`;
  const messages = [];
  let message = "";
  for (const section of sections) {
    const candidate = message ? `${message}\n\n${section}` : section;
    if (candidate.length <= max) {
      message = candidate;
      continue;
    }
    if (message) messages.push(message);
    message = `${continued}\n\n${section}`;
    if (message.length > max) {
      throw new Error(`One version section is too long for a Discord message (${message.length} > ${max}).`);
    }
  }
  if (message) messages.push(message);
  return messages;
}

// True when going from `previous` to `current` changes the major or minor
// number (1.7.3 -> 1.8.0 or 2.0.0). Patch releases and re-runs return false.
// With no previous version (first ever release) it returns true.
export function isMajorOrMinorBump(previous, current) {
  const parse = (v) => String(v).replace(/^v/, "").split(".").map(Number);
  const [cMaj, cMin] = parse(current);
  if (!previous) return true;
  const [pMaj, pMin] = parse(previous);
  return cMaj > pMaj || (cMaj === pMaj && cMin > pMin);
}

// ---------- Discord calls ----------

async function discord(method, path, token, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt <= 5) {
      const data = await res.json().catch(() => ({}));
      const wait = Number(data.retry_after ?? res.headers.get("retry-after") ?? 2);
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    return res;
  }
}

async function json(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Pinned messages in the channel. Only read, to find command lists that were
// pinned by v1.8.0 so they are cleaned up too. Uses the current pins
// endpoint and falls back to the older one if Discord doesn't recognise it.
async function pinnedMessages(channelId, token) {
  const res = await discord("GET", `/channels/${channelId}/messages/pins?limit=50`, token);
  if (res.ok) return (await res.json()).items.map((item) => item.message);
  if (res.status !== 404) await json(res, "Reading pins");
  return json(await discord("GET", `/channels/${channelId}/pins`, token), "Reading pins");
}

// The channel's last `max` messages, newest first, read 100 at a time.
async function recentMessages(channelId, token, max = 500) {
  const all = [];
  let before = "";
  while (all.length < max) {
    const page = await json(
      await discord("GET", `/channels/${channelId}/messages?limit=100${before}`, token),
      "Reading recent messages",
    );
    all.push(...page);
    if (page.length < 100) break;
    before = `&before=${page[page.length - 1].id}`;
  }
  return all;
}

export async function postCommandList({ token, channelId, messages }) {
  const me = await json(await discord("GET", "/users/@me", token), "Reading bot user");
  const isOldList = (m) => m.author?.id === me.id && m.content?.startsWith(MARKER);

  // Find old lists before posting, so the new ones are never mistaken for old.
  const pinned = await pinnedMessages(channelId, token);
  const recent = await recentMessages(channelId, token);
  const oldIds = [...new Set([...pinned, ...recent].filter(isOldList).map((m) => m.id))];

  // Post the new list first, so the channel is never left without one.
  const posted = [];
  for (const content of messages) {
    const msg = await json(
      await discord("POST", `/channels/${channelId}/messages`, token, {
        content,
        allowed_mentions: { parse: [] },
      }),
      "Posting the command list",
    );
    posted.push(msg.id);
  }

  for (const id of oldIds) {
    const res = await discord("DELETE", `/channels/${channelId}/messages/${id}`, token);
    if (!res.ok && res.status !== 404) await json(res, "Deleting the old command list");
  }
  return { posted, deleted: oldIds };
}

// ---------- run from the command line ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const template = await readFile(new URL("../docs/commands-pin.md", import.meta.url), "utf8");
  const messages = splitIntoMessages(fillVersion(template, version));

  if (process.env.DRY_RUN) {
    messages.forEach((m, i) => console.log(`--- message ${i + 1} (${m.length} chars) ---\n${m}\n`));
  } else {
    const token = process.env.DISCORD_TOKEN;
    const channelId = process.env.COMMANDS_CHANNEL_ID;
    if (!token || !channelId) {
      console.error("Set DISCORD_TOKEN and COMMANDS_CHANNEL_ID first.");
      process.exit(1);
    }
    try {
      const { posted, deleted } = await postCommandList({ token, channelId, messages });
      console.log(`Posted ${posted.length} message(s) for v${version}; deleted ${deleted.length} old one(s).`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}
