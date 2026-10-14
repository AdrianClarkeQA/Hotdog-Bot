# Discord Channel Archiver

A Cloudflare Worker that automatically archives inactive Discord channels and
restores them when activity returns. Config is per-channel, controlled from
Discord by a privileged role.

## How it works

Discord bots can't run persistently on Cloudflare (Workers have no gateway
WebSocket), so this uses two Worker entry points instead:

- **`scheduled()`** — a **cron trigger** fires once a day (03:00 UTC), checks each
  monitored channel's last-message timestamp, and archives stale channels /
  restores active ones.
- **`fetch()`** — receives Discord slash-command **interactions** over HTTP,
  verifies the signature, and updates config in **D1**.

"Activity" = the timestamp of the most recent message (decoded from its
snowflake ID). One `GET messages?limit=1` per monitored channel per sweep,
which stays comfortably inside Discord's rate limits.

## Commands

All commands require the privileged role and target a channel explicitly, so
you can run them from a single admin channel.

| Command | Effect |
|---|---|
| `/arc on <channel>` | Re-enable monitoring for a channel |
| `/arc off <channel>` | Exclude a channel from archiving |
| `/arc days <channel> <n>` | Set inactivity threshold (days) |
| `/arc status [channel]` | Show one channel's config, or all |
| `/arc restore <channel>` | Move an archived channel back to its original category |
| `/arc all <on\|off>` | Global master switch |

Every text and announcement channel is covered automatically, including ones
created later, using `DEFAULT_DAYS` from `wrangler.toml` (30 unless changed).
`/arc off` and `/arc days` store per-channel overrides. `/arc status` lists every
covered channel; ones marked `(default)` have no override.

The daily sweep leaves alone any channel in the archive that it doesn't know a
home for (moved there by hand and never restored) — use `/arc restore` on it
once to set one.

`/arc restore` can be run from any channel. Channels Botdog archived go back to
the category they came from; if that category has since been deleted, the
channel is moved out of the archive with no category. For a channel someone
moved into the archive by hand, Botdog asks which category it belongs in,
moves it there, and remembers that as its home — so the next restore (manual
or automatic) needs no question. A restored
channel gets a fresh inactivity window from the moment it's restored, so a
quiet channel isn't swept straight back into the archive the next morning.

### Dry run
With `DRY_RUN = "true"` in `wrangler.toml`, each sweep only logs what it would
archive or restore. Run `npx wrangler tail`, wait for a sweep, check the list,
`/arc off` anything you want kept, then set `DRY_RUN = "false"` and redeploy.

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
npx wrangler d1 create archiver-db
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

#### Automatic deploys (GitHub Actions)
`.github/workflows/deploy.yml` deploys on every push to `main` (or manually via
**Actions → Deploy Botdog → Run workflow**). It also tags the commit with the
version in `package.json` (e.g. `v1.1.0`) the first time that version deploys,
so bump the version in `package.json` when you release a change.

One-time setup: in the GitHub repo go to **Settings → Secrets and variables →
Actions** and add:
- `CLOUDFLARE_API_TOKEN` — create one in the Cloudflare dashboard under
  **My Profile → API Tokens → Create Token**, using the **Edit Cloudflare
  Workers** template. Add **Account → D1 → Edit** if a deploy fails with
  a D1 permissions error.
- `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard (Workers & Pages
  overview, right-hand side).

Bot secrets (`DISCORD_TOKEN` etc.) stay in Cloudflare and are not needed in
GitHub. D1 schema changes are still applied manually — see **Upgrading**.

### Upgrading to v1.2.0
v1.2.0 adds a `restored_at` column. Before the v1.2.0 code goes live, run once:
```bash
npm run db:migrate
```
Then re-register commands so `/arc restore` appears in Discord:
```bash
DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
```

### 9. Configure channels
From your admin channel:
```
/arc on #general
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
  the sweep to one call per channel.
- Restore accuracy depends on the stored `original_parent_id`, which is
  captured at archive time, so channels always return to where they were.
- The daily cron means archive/restore happens within ~24 hours of crossing
  the threshold (or of new activity in an archived channel), not instantly.
  Change `crons` in `wrangler.toml` to adjust.
