# Discord Auto-Archive Bot

Scans a server's text channels on a daily schedule and archives ones that have
gone quiet for too long: moves them into an **Archive** category and revokes
`@everyone`'s send permission. Safe by default (dry-run is on until you turn
it off), configurable live via slash commands, and built to be unit-testable.

## How it works

- **Gateway bot** (`discord.py`), not the HTTP-interactions model — it keeps a
  persistent connection via `bot.run(...)`.
- **Activity detection** (`app/activity.py`): decodes the Discord snowflake ID
  of a channel's most recent message to get its timestamp
  (`(id >> 22) + 1420070400000` = epoch ms), instead of trusting
  `message.created_at`. Channels with zero messages fall back to the
  channel's own creation date (channel IDs are snowflakes too).
- **Archiving** (`app/archiver.py`): moves the channel into the configured
  archive category and denies `send_messages` for `@everyone`. Retries on
  `discord.RateLimited` with bounded backoff so a big scan doesn't crash on
  rate limits.
- **Scheduling** (`app/cogs/scanner.py`): `discord.ext.tasks.loop(hours=24)` —
  no external cron needed.
- **Config & state** (`app/db.py`): SQLite, one row per guild — inactivity
  threshold, dry-run flag, archive category, log channel, plus an
  excluded-channels table. Changeable live with `/archiveconfig` commands,
  no restart required.

## Setup

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.sample .env
# edit .env: paste your bot token, optionally DEV_GUILD_ID for instant slash-command sync
python bot.py
```

Required bot permissions/intents: **Message Content**, **Server Members** not
required, gateway intents `guilds` + `message_content` (already enabled in
`bot.py`). The bot needs `Manage Channels` and `Manage Roles` (or channel-level
overrides) to actually move channels and edit `@everyone` permissions —
without them it logs a `Forbidden` error for that channel and continues.

**Dry-run is ON by default.** Nothing is moved or permission-edited until you
run `/archiveconfig set-dry-run enabled:False` in your server.

## Slash commands (admin-only)

- `/archiveconfig view` — show current settings
- `/archiveconfig set-threshold days:<n>` — inactivity threshold in days
- `/archiveconfig set-dry-run enabled:<bool>`
- `/archiveconfig set-category category:<#category>`
- `/archiveconfig set-log-channel channel:<#channel>` — where scan summaries post
- `/archiveconfig exclude-add channel:<#channel>` / `exclude-remove`
- `/archiveconfig scan-now` — trigger a scan immediately instead of waiting

## Tests

```powershell
pip install -r requirements.txt
pytest
```

Covers: snowflake decode/round-trip, inactivity boundary conditions (exactly
at the threshold, one second either side), empty channels falling back to
creation date, permission-denied channels, rate-limit retry/give-up, and
SQLite persistence.

## Deployment (Railway / Fly.io)

Both are "always-on" process hosts, so the bot just needs to run
`python bot.py` as a worker with `DISCORD_TOKEN` (and friends) set as
environment variables — no HTTP port to bind. Whichever platform you pick,
mount a persistent volume for `DB_PATH` (default `data/bot.db`); without a
volume, config resets to defaults on every redeploy.

- **Railway**: create a service from this repo, set env vars from
  `.env.sample`, add a volume mounted at `/app/data`, start command
  `python bot.py`.
- **Fly.io**: `fly launch` (no public services needed — remove the default
  `[[services]]` HTTP block from `fly.toml`), `fly volumes create data_vol`,
  mount it at `/app/data`, set secrets with `fly secrets set DISCORD_TOKEN=...`.

## Project layout

```
bot.py                  entry point: intents, cog loading, command sync, on_ready
app/
  config.py              .env loading + typed defaults
  db.py                  SQLite persistence (per-guild settings, exclude list)
  activity.py            snowflake decode + inactivity boundary logic
  archiver.py             scan/archive decision logic, rate-limit retry
  cogs/
    scanner.py            @tasks.loop daily scan + summary posting
    admin.py               /archiveconfig slash commands
tests/
  test_activity.py
  test_archiver.py
  test_db.py
```
