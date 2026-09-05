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
    throw new Error(`Discord ${method} ${path} -> ${res.status}: ${await res.text()}`);
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

export { rest };
