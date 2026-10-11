# Discord Channel Archiver

A Cloudflare Worker that automatically archives inactive Discord channels and
restores them when activity returns. Config is per-channel, controlled from
Discord by a privileged role.

## How it works

Discord bots can't run persistently on Cloudflare (Workers have no gateway
WebSocket), so this uses two Worker entry points instead:

- **`scheduled()`** — a **cron trigger** fires every 15 minutes, checks every
  text channel's last-message timestamp, and archives stale channels /
  restores active ones.
- **`fetch()`** — receives Discord slash-command **interactions** over HTTP,
  verifies the signature, and updates config in **D1**.

"Activity" = the timestamp of the most recent message, decoded from the
channel's `last_message_id` snowflake. The sweep makes **one**
`GET /guilds/{id}/channels` call per run, so cost doesn't grow with the
number of channels.

**Opt-out model:** every text and announcement channel is monitored by
default, including channels created later — no setup per channel. D1 only
stores exceptions (channels turned off, custom thresholds) and archive
bookkeeping.

## Commands

All commands require the privileged role and target a channel explicitly, so
you can run them from a single admin channel.

| Command | Effect |
|---|---|
| `/arc off <channel>` | Exclude a channel from monitoring |
| `/arc on <channel>` | Re-include a channel you excluded |
| `/arc days <channel> <n>` | Set inactivity threshold (days) |
| `/arc status [channel]` | Show one channel's config, or the default + exceptions |
| `/arc all <on\|off>` | Global master switch |

Channels without an override use `DEFAULT_DAYS` from `wrangler.toml` (30 by default).
Only channels the bot archived itself are restored; anything you move into the
archive category by hand stays there.

## Setup

### 1. Prerequisites
- A Discord application + bot ([Developer Portal](https://discord.com/developers/applications))
- The bot invited to your server with the **Manage Channels** permission
- A Cloudflare account
- Node.js 18+ and this repo cloned in VSCode

```bash
npm install
```

### 2. Create the Discord app
From your application in the Developer Portal, note:
- **Application ID**
- **Public Key**
- **Bot Token** (Bot tab → Reset Token)

Invite the bot with an OAuth2 URL using scopes `bot applications.commands` and
the **Manage Channels** permission.

### 3. Create the archive category
In Discord, make a category named **archive** (or any name). Enable Developer
Mode (User Settings → Advanced), right-click the category → **Copy ID**.

### 4. Create the D1 database
```bash
npx wrangler d1 create hotdog-db
```
Copy the printed `database_id` into `wrangler.toml`. Then create the tables:
```bash
npm run db:init
```

### 5. Fill in wrangler.toml
Replace the placeholders under `[vars]`:
- `GUILD_ID` — your server ID
- `ARCHIVE_CATEGORY_ID` — the archive category ID from step 3
- `PRIVILEGED_ROLE_ID` — the role allowed to run `/arc`
- `DEFAULT_DAYS` — inactivity threshold for channels without an override

### 6. Set secrets
```bash
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
```

### 7. Register the slash command
```bash
DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
```
Guild-scoped commands appear instantly.

### 8. Deploy
```bash
npm run deploy
```
Copy the deployed Worker URL, then in the Developer Portal set
**Interactions Endpoint URL** to that URL. Discord sends a verification PING;
the Worker answers it automatically.

### 9. Configure exceptions (optional)
Everything is monitored as soon as the Worker is deployed. From your admin
channel, exclude or tune individual channels:
```
/arc off #rules
/arc days #general 14
/arc status
```

## Local development
```bash
cp .dev.vars.example .dev.vars   # fill in token + public key
npm run db:init:local
npm run dev
```
Note: verifying real interactions locally needs a tunnel (e.g. `cloudflared`)
so Discord can reach your machine.

## Notes & tradeoffs
- **Empty channels** are treated as active (never archived just for being
  empty). Change this in `src/sweep.js` if you'd prefer otherwise.
- **Threads** aren't counted as activity — only channel messages. This keeps
  the sweep to a single API call.
- Restore accuracy depends on the stored `original_parent_id`, which is
  captured at archive time, so channels always return to where they were.
- The 15-minute cron means archive/restore happens within ~15 min of crossing
  the threshold, not instantly.
