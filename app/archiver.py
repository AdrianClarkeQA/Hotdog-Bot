"""Archiving logic: decide which channels are inactive and act on them.

Kept separate from the scheduler/cog so it can be unit-tested with fake
channel/category objects instead of a live Discord connection.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, List, Optional, Set

import discord

from app.activity import get_last_activity, is_inactive
from app.db import GuildSettings

log = logging.getLogger("archiver")

# Small delay between per-channel edits so we don't hammer the same bucket
# when a guild has many channels to archive in one scan.
CHANNEL_EDIT_DELAY_SECONDS = 1.0
MAX_RATE_LIMIT_RETRIES = 3


@dataclass
class ArchiveResult:
    channel_id: int
    channel_name: str
    action: str  # "archived" | "would_archive" | "skipped_excluded" | "skipped_active" | "skipped_no_category" | "error"
    detail: str = ""

    @property
    def is_archived_or_would_be(self) -> bool:
        return self.action in ("archived", "would_archive")


async def _edit_with_retry(channel: discord.TextChannel, **kwargs) -> None:
    """Apply a channel edit, retrying when Discord signals we're rate limited.

    discord.py retries 429s from Discord itself internally; `discord.RateLimited`
    is raised when the library gives up waiting (past `max_ratelimit_timeout`),
    so that's what we retry here with our own bounded backoff.
    """
    attempt = 0
    while True:
        try:
            await channel.edit(**kwargs)
            return
        except discord.RateLimited as exc:
            if attempt >= MAX_RATE_LIMIT_RETRIES:
                raise
            retry_after = exc.retry_after
            attempt += 1
            log.warning(
                "Rate limited editing #%s, retrying in %.2fs (attempt %d/%d)",
                getattr(channel, "name", channel.id),
                retry_after,
                attempt,
                MAX_RATE_LIMIT_RETRIES,
            )
            await asyncio.sleep(retry_after)


async def archive_channel(
    channel: discord.TextChannel,
    category: Optional[discord.CategoryChannel],
    dry_run: bool,
) -> ArchiveResult:
    """Move a channel into the archive category and revoke @everyone send access."""
    if dry_run:
        return ArchiveResult(channel.id, channel.name, "would_archive", "dry-run: no changes made")

    try:
        everyone = channel.guild.default_role
        overwrites = dict(channel.overwrites)
        existing = overwrites.get(everyone, discord.PermissionOverwrite())
        existing.send_messages = False
        overwrites[everyone] = existing

        await _edit_with_retry(channel, category=category, overwrites=overwrites, reason="Auto-archived: inactive channel")
        return ArchiveResult(channel.id, channel.name, "archived")
    except discord.Forbidden as exc:
        log.warning("Missing permissions to archive #%s: %s", channel.name, exc)
        return ArchiveResult(channel.id, channel.name, "error", f"forbidden: {exc}")
    except discord.RateLimited as exc:
        log.error("Gave up archiving #%s after repeated rate limiting: %s", channel.name, exc)
        return ArchiveResult(channel.id, channel.name, "error", f"rate limited: {exc}")
    except discord.HTTPException as exc:
        log.error("Failed to archive #%s: %s", channel.name, exc)
        return ArchiveResult(channel.id, channel.name, "error", f"http error: {exc}")


async def scan_guild(
    guild: discord.Guild,
    settings: GuildSettings,
    excluded_channel_ids: Set[int],
    now: Optional[datetime] = None,
) -> List[ArchiveResult]:
    """Scan all text channels in a guild and archive/report on inactive ones.

    `now` is injectable so tests can pin "the present" instead of relying on
    the wall clock.
    """
    results: List[ArchiveResult] = []

    category = None
    if settings.archive_category_id is not None:
        category = guild.get_channel(settings.archive_category_id)

    text_channels: Iterable[discord.TextChannel] = guild.text_channels
    for channel in text_channels:
        if channel.id in excluded_channel_ids:
            results.append(ArchiveResult(channel.id, channel.name, "skipped_excluded"))
            continue

        if category is not None and channel.category_id == category.id:
            results.append(ArchiveResult(channel.id, channel.name, "skipped_excluded", "already archived"))
            continue

        try:
            last_activity = await get_last_activity(channel)
        except discord.Forbidden as exc:
            log.warning("No access to read history for #%s: %s", channel.name, exc)
            results.append(ArchiveResult(channel.id, channel.name, "error", f"forbidden: {exc}"))
            continue
        except discord.HTTPException as exc:
            log.error("Error reading history for #%s: %s", channel.name, exc)
            results.append(ArchiveResult(channel.id, channel.name, "error", f"http error: {exc}"))
            continue

        if not is_inactive(last_activity, settings.inactivity_days, now=now):
            results.append(ArchiveResult(channel.id, channel.name, "skipped_active"))
            continue

        if settings.archive_category_id is not None and category is None:
            results.append(
                ArchiveResult(
                    channel.id,
                    channel.name,
                    "skipped_no_category",
                    "configured archive_category_id no longer exists",
                )
            )
            continue

        result = await archive_channel(channel, category, settings.dry_run)
        results.append(result)

        if result.action == "archived":
            await asyncio.sleep(CHANNEL_EDIT_DELAY_SECONDS)

    return results
