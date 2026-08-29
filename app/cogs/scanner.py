"""Daily scheduled scan using discord.ext.tasks (no external cron)."""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands, tasks

from app.archiver import ArchiveResult, scan_guild
from app.db import Database

log = logging.getLogger("scanner")


class ScannerCog(commands.Cog):
    def __init__(self, bot: commands.Bot, db: Database):
        self.bot = bot
        self.db = db
        self.daily_scan.start()

    def cog_unload(self) -> None:
        self.daily_scan.cancel()

    @tasks.loop(hours=24)
    async def daily_scan(self) -> None:
        for guild in self.bot.guilds:
            try:
                await self.run_scan_for_guild(guild)
            except Exception:
                log.exception("Unhandled error scanning guild %s (%s)", guild.name, guild.id)

    @daily_scan.before_loop
    async def before_daily_scan(self) -> None:
        await self.bot.wait_until_ready()

    async def run_scan_for_guild(self, guild: discord.Guild) -> list[ArchiveResult]:
        settings = await asyncio.to_thread(self.db.get_guild_settings, guild.id, self.bot.default_config)
        excluded = await asyncio.to_thread(self.db.get_excluded_channels, guild.id)

        results = await scan_guild(guild, settings, excluded)

        archived = [r for r in results if r.action in ("archived", "would_archive")]
        errors = [r for r in results if r.action == "error"]
        log.info(
            "Scan complete for %s: %d channel(s) archived/would-archive, %d error(s), dry_run=%s",
            guild.name,
            len(archived),
            len(errors),
            settings.dry_run,
        )

        if settings.log_channel_id:
            await self._post_summary(guild, settings.log_channel_id, results, settings.dry_run)

        return results

    async def _post_summary(
        self,
        guild: discord.Guild,
        log_channel_id: int,
        results: list[ArchiveResult],
        dry_run: bool,
    ) -> None:
        channel = guild.get_channel(log_channel_id)
        if channel is None:
            log.warning("Configured log channel %s not found in guild %s", log_channel_id, guild.name)
            return

        archived = [r for r in results if r.is_archived_or_would_be]
        errors = [r for r in results if r.action == "error"]

        lines = [f"**Auto-archive scan complete** (dry-run: {dry_run})"]
        if archived:
            verb = "Would archive" if dry_run else "Archived"
            lines.append(f"{verb} {len(archived)} channel(s):")
            lines.extend(f"- #{r.channel_name}" for r in archived[:20])
        else:
            lines.append("No inactive channels found.")
        if errors:
            lines.append(f"{len(errors)} error(s):")
            lines.extend(f"- #{r.channel_name}: {r.detail}" for r in errors[:10])

        try:
            await channel.send("\n".join(lines))
        except discord.HTTPException:
            log.exception("Failed to post scan summary to log channel")


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(ScannerCog(bot, bot.db))
