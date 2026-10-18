# Discord Channel Archiver

A Cloudflare Worker that automatically archives inactive Discord channels and
restores them when activity returns, posts planned gaming sessions, tracks co-op games, shows game details from RAWG, and saves quotes. Config is per-channel, controlled from
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

All `/arc` commands require the privileged role and target a channel explicitly, so
you can run them from a single admin channel.

| Command | Effect |
|---|---|
| `/arc on <channel>` | Re-enable monitoring for a channel |
| `/arc off <channel>` | Exclude a channel from archiving |
| `/arc days <channel> <n>` | Set inactivity threshold (days) |
| `/arc status [channel]` | Show one channel's config, or all |
| `/arc restore [channel]` | Move an archived channel back to its home category; with no channel, restores the one you type it in |
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

## Gaming sessions

| Command | Who | Effect |
|---|---|---|
| `/gaming <date> <time> [game]` | Everyone | Posts a planned session in the gaming channel |
| `/games info <game>` | Everyone | Posts a game's details card (see **Game details**) |
| `/games remove <game>` | Privileged role | Removes a game from the saved list |
| `/games link <game> <rawg link>` | Privileged role | Matches a saved game to the right game on RAWG |
| `/games refresh` | Privileged role | Looks up RAWG details for saved games that don't have them |

`/gaming` posts in the channel set by `GAMING_CHANNEL_ID`, wherever it's typed:

> 🎮 **Helldivers 2** session planned for <t:1791992700:F> (<t:1791992700:R>)
> Created by @Ade

- **Game** (optional): pick from the saved list or type a new name. The list
  fills itself: every game posted is saved. Most-used games are suggested
  first; matching is case-insensitive, so "helldivers 2" reuses the saved
  "Helldivers 2". Leave it out to plan a session before picking a game; the
  post then reads "**Gaming session** planned for ..." with "Game to be
  decided" underneath, and nothing is added to the saved list.
- **Date**: `today`/`tonight`, `tomorrow` (or `tmrw`), a weekday (`Saturday`
  or `sat` — the next one; today's weekday means today if the time is still to
  come), `DD/MM/YYYY`, or `DD/MM` for the next occurrence.
- **Time**: `21:00`, `2100`, `21.00`, `9pm`, `9:30pm` or `930pm`. A bare hour
  like `9` is rejected because it could be am or pm.
- Both are read as UK time (`TIMEZONE` in `wrangler.toml`), and Discord shows
  each viewer the session in their own timezone. The private confirmation
  shows the date and time Botdog picked, so a misread is easy to spot.
- Past times, impossible dates and dates over a year away are rejected with a
  message only the poster sees.
- The post never pings anyone, even if a game name contains `@everyone`.

## Co-op games

| Command | Who | Effect |
|---|---|---|
| `/coop set <game> <status>` | Everyone | Sets a game's co-op status (adds the game if it's new) |
| `/coop recommend` | Everyone | Picks a random **Ready** game and posts it where you typed |
| `/coop list [status]` | Everyone | Shows the co-op list grouped by status (only you see it) |

Statuses, picked from a list so there's nothing to type:

| Status | Meaning |
|---|---|
| Ready | Can be played now |
| Not Purchased | Want to play, not owned yet or not released |
| Parked | Taking a break from it |
| Completed It Mate | Finished, not coming back to it |

- **Same game list as `/gaming`.** A game posted with `/gaming` can be given a
  status, and a game added with `/coop set` is suggested by `/gaming`. Games
  posted with `/gaming` only join the co-op list once they're given a status.
- The `game` box suggests saved games with their current status shown next to
  them (e.g. `Helldivers 2 · Parked`); typing a new name adds it.
- The confirmation shows the change, e.g. Ready → Parked.
- `/coop recommend` only ever picks **Ready** games. If none are Ready, only you
  see the reply.
- It's `/coop set <game> <status>` rather than `/coop <game> <status>` because
  Discord doesn't let one command mix subcommands (`recommend`) with plain options.
- `/games remove` deletes a game entirely, including its co-op status.

### The co-op list post
Botdog keeps one post in the channel set by `COOP_CHANNEL_ID` (the
"Co-op Gaming" channel) listing every co-op game by status. Whenever a status
changes, or a co-op game is removed with `/games remove`, it posts the updated
list and deletes its previous post, so the channel only ever holds the latest
list:

> **Co-op games**
> Last change: **Halo**: Ready → Parked, by @Ade (2 minutes ago)
>
> **Ready** (1)
> • Valheim
>
> **Parked** (1)
> • Halo

- The new list is posted before the old one is deleted, so the channel is never
  empty. If posting fails, the old list stays up and the status change still saves.
- Setting a game to the status it already has doesn't post anything.
- The list only appears after the first status change once this is set up.
- Botdog needs **View Channel**, **Send Messages** and **Read Message History**
  in that channel. It only deletes its own list posts, never anyone else's
  messages. With `COOP_CHANNEL_ID` empty, nothing is posted.

## Game details

Botdog pulls ratings, images and details for games from
[RAWG](https://rawg.io), a free video game database. It needs the
`RAWG_API_KEY` secret (see **Set secrets**); without it everything else works
and game details are simply left out.

**Where details show up**

- **`/games info <game>`** posts a card in the channel: description, Metacritic
  score, RAWG user rating, release date, genres, platforms, average playtime,
  co-op modes, where to buy, age rating, the game's status on our co-op list,
  and a banner image. Works for any game, saved or not; looking up a game
  doesn't add it to the saved list. Botdog first shows "thinking…" while it
  asks RAWG, then fills in the card.
- **`/gaming` posts** get a small details box under the announcement:
  Metacritic score, co-op modes, average playtime and a thumbnail.
- **The co-op list** (`/coop list` and the list post) shows each game as
  `Helldivers 2 · Metacritic 82 · 18h avg playtime`, leaving out whatever RAWG
  doesn't have.

**How games are matched**

- A game is looked up the first time it's saved: after its first `/gaming`
  post (the details box is added to the post a moment later) or when it's
  added with `/coop set` (before the list post updates). The result is saved,
  so later posts don't ask RAWG again.
- RAWG's search is fuzzy, so Botdog picks the result whose name matches and
  that's popular on RAWG. "Halo" matches Halo Infinite rather than a little
  itch.io game also called "Halo". If it picks the wrong game, or finds
  nothing, fix it with `/games link <game> <rawg link>`: find the game on
  [rawg.io](https://rawg.io) and paste its page link, e.g.
  `https://rawg.io/games/deep-rock-galactic`.
- Games saved before v1.10.0 have no details until `/games refresh` is run. It
  looks up 20 games per run (staying inside Cloudflare's per-request limits),
  lists any it couldn't find, and says if there are more to do. Each run also
  retries earlier misses, oldest first.
- RAWG data is community-made, so some games have gaps (no Metacritic score,
  no co-op tags). Missing details are left out rather than shown as blank.

**RAWG's terms**: the free plan allows 20,000 requests a month (Botdog uses a
handful per new game) and asks for a link back to RAWG wherever its data is
shown. Every card and details box links to the game's RAWG page and says
"Data from RAWG"; the co-op list ends with a RAWG link when it shows any
RAWG data.

## Quotes

| Command | Who | Effect |
|---|---|---|
| `/quote <text>` | Everyone | Saves a quote; Botdog asks who said it, then posts it in the quotes channel |
| `/quotes <who>` | Everyone | Shows that person's last 3 quotes, newest first |
| Right-click a message → **Apps → Save as quote** | Everyone | Posts that message as a quote straight away, credited to whoever wrote it |

Quotes are posted in the channel set by `QUOTES_CHANNEL_ID`, wherever the
command is typed:

> 💬 “I'm not lost, I'm exploring”
> — @Ade

- **Who said it?** After `/quote`, a private prompt (only you see it) offers a
  member picker, a **Someone not in the server** button that opens a box to
  type a name, and **Cancel**. Prompts left unanswered are cleared after a day.
- **`/quotes`** suggests everyone who's been quoted, most-quoted first. Typing a
  name without picking a suggestion works too (case doesn't matter). The
  answer is posted where you typed it so everyone can see; if there are no
  quotes for that person, only you see the reply.
- Members are shown as mentions, so a name change shows up on old quotes too.
  Nobody is pinged, even if a quote contains `@everyone`.
- **Save as quote** adds a link back to the original message, and the same
  message can't be saved twice.

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
npx wrangler secret put RAWG_API_KEY
```
`RAWG_API_KEY` is optional: get a free key at <https://rawg.io/apidocs>. For
local testing with `npm run dev`, put the same names and values in `.dev.vars`
(ignored by Git, so never committed).

### 7. Register the slash commands
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
- `DISCORD_TOKEN` — the same bot token as in Cloudflare. Only used to post the
  command list (see **Command list post** below).

Other bot secrets stay in Cloudflare and are not needed in GitHub. D1 schema changes are still applied manually — see **Upgrading**.

#### Command list post
When a deploy is a new major or minor version (e.g. 1.7.x to 1.8.0, or to
2.0.0), the workflow runs `scripts/post-commands-pin.js`. It posts
`docs/commands-pin.md` in the commands channel (`COMMANDS_CHANNEL_ID` in
`deploy.yml`), then deletes Botdog's previous command list. Nothing is pinned.

- Patch releases (1.8.0 to 1.8.1) and re-runs of an already-tagged version
  don't post.
- `{{VERSION}}` in the file is replaced with the version from `package.json`.
- Over 2,000 characters, the list is split between version sections into
  several messages; later ones start with "**Botdog commands (continued)**".
- Each version section is a bold heading with a divider line under it; the
  list is only ever split between sections.
- The new list is posted before the old one is deleted. Old lists are found by
  being Botdog's own messages starting with "**Botdog commands**" among the
  channel's last 500 messages and its pins, so other messages are never touched. If posting fails, the old list stays and the
  deploy still succeeds.
- Botdog needs **View Channel**, **Send Messages** and **Read Message History**
  in that channel.
- To repost without a new version: **Actions → Deploy Botdog → Run workflow**,
  tick **Repost the command list**, then **Run workflow**.
- Preview the messages locally: `DRY_RUN=1 node scripts/post-commands-pin.js`.
- When a release adds or changes commands, update `docs/commands-pin.md` in the
  same pull request.

### Upgrading to v1.10.0
v1.10.0 adds game details from RAWG: `/games info`, `/games link`,
`/games refresh`, details boxes on `/gaming` posts, and Metacritic and
playtime on the co-op list.
1. Add the new database columns (run once; a second run errors with
   "duplicate column", which is harmless):
   ```bash
   npm run db:migrate:rawg
   ```
2. Add the RAWG key to Cloudflare:
   ```bash
   npx wrangler secret put RAWG_API_KEY
   ```
3. Merge the pull request. The deploy runs automatically and, as a minor
   release, reposts the command list.
4. Re-register commands so `/games info`, `link` and `refresh` appear:
   ```bash
   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
   ```
5. Run `/games refresh` until it says every game is done, then use
   `/games link` for any it couldn't find.

### Upgrading to v1.9.0
v1.9.0 makes the game optional in `/gaming`, so a session can be planned for a
time without choosing a game. Discord needs required options before optional
ones, so the command is now `/gaming <date> <time> [game]`.
1. No database changes.
2. Merge the pull request. The deploy runs automatically and, as a minor
   release, reposts the command list.
3. Re-register commands so Discord picks up the new option order:
   ```bash
   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
   ```
   Until this is done, Discord still shows the game as required.

### Upgrading to v1.8.1
v1.8.1 drops the divider line above each version heading and stops pinning the
command list. As a patch release it doesn't post on its own, so after it
deploys, repost once from **Actions → Deploy Botdog → Run workflow** with
**Repost the command list** ticked. That also deletes the pinned v1.8.0 list.
**Pin Messages** is no longer needed in the commands channel.

### Upgrading to v1.8.0
v1.8.0 posts the command list automatically on major and minor releases.
1. Add the `DISCORD_TOKEN` repository secret in GitHub (see above).
2. Give Botdog the four permissions above in the commands channel.
3. No database or command changes. Merging v1.8.0 posts the first list.

### Upgrading to v1.7.0
v1.7.0 adds the co-op list post. Before the v1.7.0 code goes live:
1. Create the `coop_board_posts` table (safe to run more than once):
   ```bash
   npm run db:migrate:coopboard
   ```
2. Set `COOP_CHANNEL_ID` in `wrangler.toml` to the "Co-op Gaming" channel's ID.
   Botdog needs **View Channel**, **Send Messages** and **Read Message History** there.
3. No command changes, so there's no need to re-register commands.
4. Optional, one time: import the co-op games and statuses from the Notion
   "Co-op Gaming Suggestions" database (safe to run more than once):
   ```bash
   npx wrangler d1 execute hotdog-db --remote --file=./seeds/coop-from-notion.sql
   ```

### Upgrading to v1.6.0
v1.6.0 adds the co-op games list (`/coop`). Before the v1.6.0 code goes live:
1. Add the `coop_status` column to the games table (run once — a second run
   errors with "duplicate column", which is harmless):
   ```bash
   npm run db:migrate:coop
   ```
2. After it deploys, re-register commands so `/coop` appears:
   ```bash
   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
   ```

### Upgrading to v1.5.0
v1.5.0 adds quotes. Before the v1.5.0 code goes live:
1. Create the `quotes` table (safe to run more than once):
   ```bash
   npm run db:migrate:quotes
   ```
2. `QUOTES_CHANNEL_ID` in `wrangler.toml` is already set to the quotes channel.
   Botdog needs **View Channel** and **Send Messages** there.
3. After it deploys, re-register commands so `/quote`, `/quotes` and
   **Save as quote** appear:
   ```bash
   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
   ```

### Upgrading to v1.2.0
v1.2.0 adds a `restored_at` column. Before the v1.2.0 code goes live, run once:
```bash
npm run db:migrate
```
Then re-register commands so `/arc restore` appears in Discord:
```bash
DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
```

### Upgrading to v1.4.0
v1.4.0 lets `/gaming` take dates like `tomorrow` or `Saturday` and times like
`2100` or `9pm`. No database changes. After it deploys, re-register commands
so the new hints and longer time box show in Discord:
```bash
DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... GUILD_ID=... npm run register
```

### Upgrading to v1.3.0
v1.3.0 adds `/gaming` and `/games`. Before the v1.3.0 code goes live:
1. Create the `games` table (safe to run more than once):
   ```bash
   npm run db:migrate:games
   ```
2. Set `GAMING_CHANNEL_ID` in `wrangler.toml` to the channel sessions should be
   posted in (Discord: right-click the channel → **Copy Channel ID**; needs
   Developer Mode on). Botdog needs **View Channel** and **Send Messages** there.
3. Re-register commands so `/gaming` and `/games` appear:
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
Run the tests (no setup needed — uses Node's built-in SQLite and a mocked
Discord API):
```bash
npm test
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
