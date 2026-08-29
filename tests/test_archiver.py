"""Unit tests for archiver.py using lightweight fake discord objects.

We avoid a live gateway connection entirely: fakes implement just the
attributes/methods archiver.py touches, so the archiving decision logic and
rate-limit handling can be exercised in isolation.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import List, Optional

import discord

from app.activity import datetime_to_snowflake
from app.archiver import archive_channel, scan_guild
from app.db import GuildSettings

NOW = datetime(2024, 6, 1, tzinfo=timezone.utc)


class FakeMessage:
    def __init__(self, id_: int):
        self.id = id_


class FakeCategory:
    def __init__(self, id_: int):
        self.id = id_


class FakeGuild:
    def __init__(self):
        self.default_role = "@everyone"
        self._channels = {}

    def get_channel(self, channel_id: int):
        return self._channels.get(channel_id)


class FakeChannel:
    """Stands in for discord.TextChannel."""

    def __init__(
        self,
        channel_id: int,
        name: str,
        guild: FakeGuild,
        messages: Optional[List[FakeMessage]] = None,
        category_id: Optional[int] = None,
        raise_on_history: Optional[Exception] = None,
        raise_on_edit: Optional[Exception] = None,
    ):
        self.id = channel_id
        self.name = name
        self.guild = guild
        self._messages = messages or []
        self.category_id = category_id
        self.overwrites = {}
        self.raise_on_history = raise_on_history
        self.raise_on_edit = raise_on_edit
        self.edit_calls = []

    async def history(self, *, limit: int):
        if self.raise_on_history:
            raise self.raise_on_history
        for message in self._messages[:limit]:
            yield message

    async def edit(self, **kwargs):
        self.edit_calls.append(kwargs)
        if self.raise_on_edit:
            raise self.raise_on_edit


def make_settings(**overrides) -> GuildSettings:
    base = dict(
        guild_id=1,
        inactivity_days=30,
        dry_run=False,
        archive_category_id=999,
        archive_category_name="Archive",
        log_channel_id=None,
    )
    base.update(overrides)
    return GuildSettings(**base)


def channel_with_last_message_days_ago(guild, days_ago, channel_id=1, name="general", **kwargs):
    ts = NOW - timedelta(days=days_ago)
    return FakeChannel(channel_id, name, guild, messages=[FakeMessage(datetime_to_snowflake(ts))], **kwargs)


# --- archive_channel ---------------------------------------------------


async def test_archive_channel_dry_run_makes_no_calls():
    guild = FakeGuild()
    channel = FakeChannel(1, "general", guild)
    category = FakeCategory(999)

    result = await archive_channel(channel, category, dry_run=True)

    assert result.action == "would_archive"
    assert channel.edit_calls == []


async def test_archive_channel_moves_and_denies_send():
    guild = FakeGuild()
    channel = FakeChannel(1, "general", guild)
    category = FakeCategory(999)

    result = await archive_channel(channel, category, dry_run=False)

    assert result.action == "archived"
    assert len(channel.edit_calls) == 1
    call = channel.edit_calls[0]
    assert call["category"] is category
    overwrite = call["overwrites"]["@everyone"]
    assert overwrite.send_messages is False


async def test_archive_channel_handles_forbidden_gracefully():
    guild = FakeGuild()
    fake_response = SimpleNamespace(status=403, reason="Forbidden")
    channel = FakeChannel(
        1, "general", guild,
        raise_on_edit=discord.Forbidden(fake_response, "missing access"),
    )
    category = FakeCategory(999)

    result = await archive_channel(channel, category, dry_run=False)

    assert result.action == "error"
    assert "forbidden" in result.detail


async def test_archive_channel_retries_then_succeeds_on_rate_limit():
    guild = FakeGuild()
    channel = FakeChannel(1, "general", guild)
    category = FakeCategory(999)

    calls = {"n": 0}
    original_edit = channel.edit

    async def flaky_edit(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise discord.RateLimited(retry_after=0.01)
        await original_edit(**kwargs)

    channel.edit = flaky_edit

    result = await archive_channel(channel, category, dry_run=False)

    assert result.action == "archived"
    assert calls["n"] == 2


async def test_archive_channel_gives_up_after_max_retries():
    guild = FakeGuild()
    channel = FakeChannel(1, "general", guild)
    category = FakeCategory(999)

    async def always_rate_limited(**kwargs):
        raise discord.RateLimited(retry_after=0.01)

    channel.edit = always_rate_limited

    result = await archive_channel(channel, category, dry_run=False)

    assert result.action == "error"
    assert "rate limited" in result.detail


# --- scan_guild ----------------------------------------------------------


async def test_scan_guild_skips_excluded_channel():
    guild = FakeGuild()
    channel = channel_with_last_message_days_ago(guild, days_ago=100)
    guild.text_channels = [channel]

    results = await scan_guild(guild, make_settings(), excluded_channel_ids={channel.id}, now=NOW)

    assert results[0].action == "skipped_excluded"
    assert channel.edit_calls == []


async def test_scan_guild_skips_active_channel():
    guild = FakeGuild()
    channel = channel_with_last_message_days_ago(guild, days_ago=1)
    guild.text_channels = [channel]

    results = await scan_guild(guild, make_settings(inactivity_days=30), excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "skipped_active"


async def test_scan_guild_archives_exactly_at_threshold_boundary():
    guild = FakeGuild()
    channel = channel_with_last_message_days_ago(guild, days_ago=30)
    guild.text_channels = [channel]
    guild._channels[999] = FakeCategory(999)

    results = await scan_guild(guild, make_settings(inactivity_days=30), excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "archived"


async def test_scan_guild_handles_empty_channel_via_creation_date():
    guild = FakeGuild()
    creation_ts = NOW - timedelta(days=100)
    channel = FakeChannel(datetime_to_snowflake(creation_ts), "empty-channel", guild, messages=[])
    guild.text_channels = [channel]
    guild._channels[999] = FakeCategory(999)

    results = await scan_guild(guild, make_settings(inactivity_days=30), excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "archived"


async def test_scan_guild_reports_error_when_history_forbidden():
    guild = FakeGuild()
    fake_response = SimpleNamespace(status=403, reason="Forbidden")
    channel = FakeChannel(
        1, "no-access", guild,
        raise_on_history=discord.Forbidden(fake_response, "missing access"),
    )
    guild.text_channels = [channel]

    results = await scan_guild(guild, make_settings(), excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "error"
    assert "forbidden" in results[0].detail


async def test_scan_guild_no_category_configured_skips_with_reason():
    guild = FakeGuild()
    channel = channel_with_last_message_days_ago(guild, days_ago=100)
    guild.text_channels = [channel]
    # archive_category_id points at a category that no longer exists.
    settings = make_settings(archive_category_id=12345)

    results = await scan_guild(guild, settings, excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "skipped_no_category"


async def test_scan_guild_skips_channel_already_in_archive_category():
    guild = FakeGuild()
    guild._channels[999] = FakeCategory(999)
    channel = channel_with_last_message_days_ago(guild, days_ago=100, category_id=999)
    guild.text_channels = [channel]

    results = await scan_guild(guild, make_settings(), excluded_channel_ids=set(), now=NOW)

    assert results[0].action == "skipped_excluded"
    assert results[0].detail == "already archived"
