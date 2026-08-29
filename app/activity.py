"""Snowflake decoding and channel-inactivity detection.

Kept free of discord.py-specific types where possible so the boundary-value
logic (snowflake math, threshold comparison) is trivially unit-testable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

# Discord epoch: 2015-01-01T00:00:00Z, in milliseconds since Unix epoch.
DISCORD_EPOCH_MS = 1420070400000


def snowflake_to_datetime(snowflake: int) -> datetime:
    """Decode a Discord snowflake ID into a UTC datetime.

    Timestamp bits are the top 42 bits: (snowflake >> 22) is the number of
    milliseconds since the Discord epoch.
    """
    ms_since_discord_epoch = snowflake >> 22
    unix_ms = ms_since_discord_epoch + DISCORD_EPOCH_MS
    return datetime.fromtimestamp(unix_ms / 1000, tz=timezone.utc)


def datetime_to_snowflake(dt: datetime) -> int:
    """Inverse of snowflake_to_datetime, useful for building test fixtures."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    unix_ms = int(dt.timestamp() * 1000)
    ms_since_discord_epoch = unix_ms - DISCORD_EPOCH_MS
    return ms_since_discord_epoch << 22


class HistoryChannel(Protocol):
    """Structural type covering the bits of discord.TextChannel we need."""

    id: int

    def history(self, *, limit: int): ...


async def get_last_activity(channel: HistoryChannel) -> datetime:
    """Return the last-activity timestamp for a channel.

    Uses the most recent message's snowflake ID rather than trusting
    `message.created_at` directly, per the decoding contract above. Falls
    back to the channel's own creation date (also a snowflake) when the
    channel has zero messages.
    """
    async for message in channel.history(limit=1):
        return snowflake_to_datetime(message.id)
    return snowflake_to_datetime(channel.id)


def is_inactive(
    last_activity: datetime,
    threshold_days: int,
    now: Optional[datetime] = None,
) -> bool:
    """A channel is inactive once its idle time is >= the threshold.

    Using >= (not >) means a channel sitting *exactly* on the threshold is
    treated as inactive - this is the boundary condition tests pin down.
    """
    now = now or datetime.now(timezone.utc)
    return (now - last_activity) >= timedelta(days=threshold_days)
