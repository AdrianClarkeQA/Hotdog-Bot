"""Environment-backed configuration.

Values here are the *defaults* used the first time a guild is seen. After
that, per-guild settings live in SQLite (see db.py) and can be changed live
with the /archiveconfig slash commands without restarting the bot.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    discord_token: str
    dev_guild_id: int | None
    inactivity_days: int
    dry_run: bool
    archive_category_name: str
    log_channel_id: int | None
    db_path: str


def load_config() -> Config:
    token = os.getenv("DISCORD_TOKEN", "")
    if not token:
        raise RuntimeError(
            "DISCORD_TOKEN is not set. Copy .env.sample to .env and fill it in."
        )

    dev_guild_raw = os.getenv("DEV_GUILD_ID", "").strip()
    log_channel_raw = os.getenv("LOG_CHANNEL_ID", "").strip()

    return Config(
        discord_token=token,
        dev_guild_id=int(dev_guild_raw) if dev_guild_raw else None,
        inactivity_days=_get_int("INACTIVITY_DAYS", 30),
        dry_run=_get_bool("DRY_RUN", True),
        archive_category_name=os.getenv("ARCHIVE_CATEGORY_NAME", "Archive"),
        log_channel_id=int(log_channel_raw) if log_channel_raw else None,
        db_path=os.getenv("DB_PATH", "data/bot.db"),
    )
