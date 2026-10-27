// Thin wrapper over the Discord REST API. No gateway, no framework —
// just the handful of calls the Worker needs.

const API = "https://discord.com/api/v10";

async function rest(env, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Respect rate limits: if we're throttled, wait and retry once.
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, retry * 1000));
    return rest(env, method, path, body);
  }

  if (!res.ok && res.status !== 404) {
    const err = new Error(`Discord ${method} ${path} -> ${res.status}: ${await res.text()}`);
    err.status = res.status; // lets callers tell e.g. a missing permission (403) from a bad request (400)
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// All non-thread channels in the guild.
export async function listGuildChannels(env) {
  return rest(env, "GET", `/guilds/${env.GUILD_ID}/channels`);
}

// Fetch a single channel object.
export async function getChannel(env, channelId) {
  return rest(env, "GET", `/channels/${channelId}`);
}

// Timestamp (ms) of the most recent message, or null if the channel is empty.
export async function lastMessageTime(env, channelId) {
  const msgs = await rest(env, "GET", `/channels/${channelId}/messages?limit=1`);
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  // Decode the snowflake: (id >> 22) + Discord epoch.
  const id = BigInt(msgs[0].id);
  return Number((id >> 22n) + 1420070400000n);
}

// Move a channel to a new category (parent). parentId null = no category.
export async function moveChannel(env, channelId, parentId) {
  return rest(env, "PATCH", `/channels/${channelId}`, { parent_id: parentId });
}

// Post a message in a channel. allowed_mentions parse [] means nothing in the
// text pings anyone (e.g. a game named "@everyone"), and SUPPRESS_EMBEDS (4)
// stops links in game names unfurling. A message with its own embeds (game
// details) can't use SUPPRESS_EMBEDS, as that would hide them too, and nor can
// a post whose link should show as a card (`unfurl`, e.g. an event link).
export async function postMessage(env, channelId, content, { embeds, unfurl = false } = {}) {
  const extra = embeds?.length ? { embeds } : unfurl ? {} : { flags: 4 };
  return rest(env, "POST", `/channels/${channelId}/messages`, {
    content,
    allowed_mentions: { parse: [] },
    ...extra,
  });
}

// Create a scheduled event in the server (POST /guilds/{id}/scheduled-events).
// Needs Create Events, plus View Channel and Connect on a voice event's channel.
// Returns the event; throws (with .status) if Discord refuses it.
export async function createScheduledEvent(env, body) {
  const event = await rest(env, "POST", `/guilds/${env.GUILD_ID}/scheduled-events`, body);
  if (!event?.id) {
    // rest() returns 404s instead of throwing: unknown server or channel.
    const err = new Error(`Discord POST scheduled-events -> 404: ${JSON.stringify(event)}`);
    err.status = 404;
    throw err;
  }
  return event;
}

// Change a message Botdog posted (e.g. add game details once RAWG answers).
export async function editMessage(env, channelId, messageId, body) {
  return rest(env, "PATCH", `/channels/${channelId}/messages/${messageId}`, {
    allowed_mentions: { parse: [] },
    ...body,
  });
}

// Fill in the reply to a command Botdog answered with "thinking…" (a deferred
// reply), using the interaction's own token.
export async function editOriginalReply(env, interaction, body) {
  return rest(env, "PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    allowed_mentions: { parse: [] },
    ...body,
  });
}

// Delete a message. A message that's already gone (404) counts as deleted.
export async function deleteMessage(env, channelId, messageId) {
  return rest(env, "DELETE", `/channels/${channelId}/messages/${messageId}`);
}

export { rest };
