// One-time (re-run when commands change) registration of the /arc command.
// Run locally:  node scripts/register-commands.js
// Requires env vars: DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID
// (guild-scoped commands appear instantly; global ones can take ~1h.)

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !APP_ID || !GUILD_ID) {
  console.error("Set DISCORD_TOKEN, DISCORD_APPLICATION_ID and GUILD_ID first.");
  process.exit(1);
}

// Option type constants from the Discord API.
const SUB = 1;
const CHANNEL = 7;
const INTEGER = 4;
const STRING = 3;

const command = {
  name: "arc",
  description: "Manage channel auto-archiving",
  options: [
    {
      type: SUB,
      name: "on",
      description: "Enable monitoring for a channel",
      options: [
        { type: CHANNEL, name: "channel", description: "Channel to monitor", required: true },
      ],
    },
    {
      type: SUB,
      name: "off",
      description: "Disable monitoring for a channel",
      options: [
        { type: CHANNEL, name: "channel", description: "Channel to ignore", required: true },
      ],
    },
    {
      type: SUB,
      name: "days",
      description: "Set inactivity threshold for a channel",
      options: [
        { type: CHANNEL, name: "channel", description: "Target channel", required: true },
        { type: INTEGER, name: "n", description: "Days of inactivity", required: true, min_value: 1 },
      ],
    },
    {
      type: SUB,
      name: "status",
      description: "Show config for one channel, or all",
      options: [
        { type: CHANNEL, name: "channel", description: "Channel (omit for all)", required: false },
      ],
    },
    {
      type: SUB,
      name: "restore",
      description: "Move an archived channel back to its original category",
      options: [
        {
          type: CHANNEL,
          name: "channel",
          description: "Archived channel to restore",
          required: true,
          channel_types: [0, 5], // text + announcement, matching what the sweep archives
        },
      ],
    },
    {
      type: SUB,
      name: "all",
      description: "Global master switch",
      options: [
        {
          type: STRING,
          name: "state",
          description: "on or off",
          required: true,
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ],
        },
      ],
    },
  ],
};

const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bot ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(command),
});

if (res.ok) {
  console.log("✅ Registered /arc");
} else {
  console.error("❌ Failed:", res.status, await res.text());
  process.exit(1);
}
