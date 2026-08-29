"""SQLite-backed config/state persistence.

Synchronous by design (sqlite3 is fast for a local single file); callers
running inside the bot's event loop should invoke these through
`asyncio.to_thread(...)` to avoid blocking the gateway connection.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Optional, Set

from app.config import Config


@dataclass
class GuildSettings:
    guild_id: int
    inactivity_days: int
    dry_run: bool
    archive_category_id: Optional[int]
    archive_category_name: str
    log_channel_id: Optional[int]


class Database:
    def __init__(self, db_path: str):
        self.db_path = db_path
        directory = os.path.dirname(db_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS guild_settings (
                    guild_id INTEGER PRIMARY KEY,
                    inactivity_days INTEGER NOT NULL,
                    dry_run INTEGER NOT NULL,
                    archive_category_id INTEGER,
                    archive_category_name TEXT NOT NULL,
                    log_channel_id INTEGER
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS excluded_channels (
                    guild_id INTEGER NOT NULL,
                    channel_id INTEGER NOT NULL,
                    PRIMARY KEY (guild_id, channel_id)
                )
                """
            )

    def get_guild_settings(self, guild_id: int, defaults: Config) -> GuildSettings:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM guild_settings WHERE guild_id = ?", (guild_id,)
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO guild_settings
                        (guild_id, inactivity_days, dry_run, archive_category_id,
                         archive_category_name, log_channel_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        guild_id,
                        defaults.inactivity_days,
                        int(defaults.dry_run),
                        None,
                        defaults.archive_category_name,
                        defaults.log_channel_id,
                    ),
                )
                return GuildSettings(
                    guild_id=guild_id,
                    inactivity_days=defaults.inactivity_days,
                    dry_run=defaults.dry_run,
                    archive_category_id=None,
                    archive_category_name=defaults.archive_category_name,
                    log_channel_id=defaults.log_channel_id,
                )
            return GuildSettings(
                guild_id=row["guild_id"],
                inactivity_days=row["inactivity_days"],
                dry_run=bool(row["dry_run"]),
                archive_category_id=row["archive_category_id"],
                archive_category_name=row["archive_category_name"],
                log_channel_id=row["log_channel_id"],
            )

    def update_guild_settings(self, guild_id: int, **fields) -> None:
        if not fields:
            return
        columns = ", ".join(f"{key} = ?" for key in fields)
        values = list(fields.values())
        with self._connect() as conn:
            conn.execute(
                f"UPDATE guild_settings SET {columns} WHERE guild_id = ?",
                (*values, guild_id),
            )

    def get_excluded_channels(self, guild_id: int) -> Set[int]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT channel_id FROM excluded_channels WHERE guild_id = ?",
                (guild_id,),
            ).fetchall()
            return {row["channel_id"] for row in rows}

    def add_excluded_channel(self, guild_id: int, channel_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO excluded_channels (guild_id, channel_id) VALUES (?, ?)",
                (guild_id, channel_id),
            )

    def remove_excluded_channel(self, guild_id: int, channel_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM excluded_channels WHERE guild_id = ? AND channel_id = ?",
                (guild_id, channel_id),
            )
            return cursor.rowcount > 0
