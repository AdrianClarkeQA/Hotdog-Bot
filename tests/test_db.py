import os

import pytest

from app.config import Config
from app.db import Database


@pytest.fixture()
def db(tmp_path):
    return Database(str(tmp_path / "test.db"))


@pytest.fixture()
def defaults():
    return Config(
        discord_token="x",
        dev_guild_id=None,
        inactivity_days=14,
        dry_run=True,
        archive_category_name="Archive",
        log_channel_id=None,
        db_path="unused",
    )


def test_get_guild_settings_creates_defaults_on_first_access(db, defaults):
    settings = db.get_guild_settings(123, defaults)

    assert settings.inactivity_days == 14
    assert settings.dry_run is True
    assert settings.archive_category_id is None


def test_get_guild_settings_is_persisted_across_calls(db, defaults):
    db.get_guild_settings(123, defaults)
    db.update_guild_settings(123, inactivity_days=7, dry_run=0)

    settings = db.get_guild_settings(123, defaults)

    assert settings.inactivity_days == 7
    assert settings.dry_run is False


def test_excluded_channels_add_remove(db, defaults):
    db.get_guild_settings(123, defaults)

    db.add_excluded_channel(123, 999)
    assert db.get_excluded_channels(123) == {999}

    removed = db.remove_excluded_channel(123, 999)
    assert removed is True
    assert db.get_excluded_channels(123) == set()


def test_remove_excluded_channel_returns_false_if_absent(db, defaults):
    db.get_guild_settings(123, defaults)
    assert db.remove_excluded_channel(123, 555) is False


def test_settings_are_scoped_per_guild(db, defaults):
    db.get_guild_settings(1, defaults)
    db.get_guild_settings(2, defaults)
    db.update_guild_settings(1, inactivity_days=99)

    assert db.get_guild_settings(1, defaults).inactivity_days == 99
    assert db.get_guild_settings(2, defaults).inactivity_days == 14
