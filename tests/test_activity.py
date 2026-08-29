from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.activity import (
    DISCORD_EPOCH_MS,
    datetime_to_snowflake,
    get_last_activity,
    is_inactive,
    snowflake_to_datetime,
)


def test_snowflake_zero_is_discord_epoch():
    assert snowflake_to_datetime(0) == datetime.fromtimestamp(
        DISCORD_EPOCH_MS / 1000, tz=timezone.utc
    )


def test_snowflake_roundtrip():
    original = datetime(2023, 6, 15, 12, 30, 0, tzinfo=timezone.utc)
    snowflake = datetime_to_snowflake(original)
    decoded = snowflake_to_datetime(snowflake)
    # Millisecond precision only.
    assert abs((decoded - original).total_seconds()) < 0.001


def test_snowflake_known_value():
    # A real Discord message ID with a known creation time.
    # 175928847299117063 -> 2016-04-30T11:18:25.796Z
    snowflake = 175928847299117063
    decoded = snowflake_to_datetime(snowflake)
    expected = datetime(2016, 4, 30, 11, 18, 25, 796000, tzinfo=timezone.utc)
    assert abs((decoded - expected).total_seconds()) < 0.001


@pytest.mark.parametrize(
    "days_idle,threshold_days,expected",
    [
        (29, 30, False),  # just under threshold -> still active
        (30, 30, True),  # exactly at threshold -> inactive (boundary)
        (31, 30, True),  # past threshold -> inactive
        (0, 30, False),  # brand new activity -> active
    ],
)
def test_is_inactive_boundaries(days_idle, threshold_days, expected):
    now = datetime(2024, 1, 31, 0, 0, 0, tzinfo=timezone.utc)
    last_activity = now - timedelta(days=days_idle)
    assert is_inactive(last_activity, threshold_days, now=now) is expected


def test_is_inactive_one_second_before_threshold_is_active():
    now = datetime(2024, 1, 31, 0, 0, 0, tzinfo=timezone.utc)
    last_activity = now - timedelta(days=30) + timedelta(seconds=1)
    assert is_inactive(last_activity, 30, now=now) is False


def test_is_inactive_one_second_after_threshold_is_inactive():
    now = datetime(2024, 1, 31, 0, 0, 0, tzinfo=timezone.utc)
    last_activity = now - timedelta(days=30) - timedelta(seconds=1)
    assert is_inactive(last_activity, 30, now=now) is True


class _FakeMessage:
    def __init__(self, id_: int):
        self.id = id_


class _FakeChannelWithHistory:
    def __init__(self, channel_id: int, message_ids: list[int]):
        self.id = channel_id
        self._message_ids = message_ids

    async def history(self, *, limit: int):
        for message_id in self._message_ids[:limit]:
            yield _FakeMessage(message_id)


async def test_get_last_activity_uses_most_recent_message():
    msg_time = datetime(2024, 3, 1, tzinfo=timezone.utc)
    channel = _FakeChannelWithHistory(channel_id=1, message_ids=[datetime_to_snowflake(msg_time)])

    result = await get_last_activity(channel)

    assert abs((result - msg_time).total_seconds()) < 0.001


async def test_get_last_activity_falls_back_to_channel_creation_when_empty():
    creation_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
    channel = _FakeChannelWithHistory(channel_id=datetime_to_snowflake(creation_time), message_ids=[])

    result = await get_last_activity(channel)

    assert abs((result - creation_time).total_seconds()) < 0.001
