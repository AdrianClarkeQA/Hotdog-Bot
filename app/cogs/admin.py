"""Admin slash commands to view/change auto-archive settings live."""
from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

from app.db import Database

log = logging.getLogger("admin")


class AdminCog(commands.Cog):
    def __init__(self, bot: commands.Bot, db: Database):
        self.bot = bot
        self.db = db

    archiveconfig = app_commands.Group(
        name="archiveconfig",
        description="View or change auto-archive settings for this server.",
        default_permissions=discord.Permissions(administrator=True),
        guild_only=True,
    )

    @archiveconfig.command(name="view", description="Show current auto-archive settings.")
    async def view(self, interaction: discord.Interaction) -> None:
        settings = await asyncio.to_thread(
            self.db.get_guild_settings, interaction.guild_id, self.bot.default_config
        )
        excluded = await asyncio.to_thread(self.db.get_excluded_channels, interaction.guild_id)
        excluded_text = ", ".join(f"<#{cid}>" for cid in excluded) or "none"
        category_text = f"<#{settings.archive_category_id}>" if settings.archive_category_id else "not set"

        await interaction.response.send_message(
            "**Auto-archive settings**\n"
            f"- Inactivity threshold: {settings.inactivity_days} day(s)\n"
            f"- Dry run: {settings.dry_run}\n"
            f"- Archive category: {category_text}\n"
            f"- Log channel: {f'<#{settings.log_channel_id}>' if settings.log_channel_id else 'not set'}\n"
            f"- Excluded channels: {excluded_text}",
            ephemeral=True,
        )

    @archiveconfig.command(name="set-threshold", description="Set the inactivity threshold in days.")
    @app_commands.describe(days="Number of days of inactivity before a channel is archived.")
    async def set_threshold(self, interaction: discord.Interaction, days: app_commands.Range[int, 1, 3650]) -> None:
        await asyncio.to_thread(self.db.update_guild_settings, interaction.guild_id, inactivity_days=days)
        await interaction.response.send_message(f"Inactivity threshold set to {days} day(s).", ephemeral=True)

    @archiveconfig.command(name="set-dry-run", description="Enable or disable dry-run mode.")
    @app_commands.describe(enabled="If true, the bot logs intended actions but makes no changes.")
    async def set_dry_run(self, interaction: discord.Interaction, enabled: bool) -> None:
        await asyncio.to_thread(self.db.update_guild_settings, interaction.guild_id, dry_run=int(enabled))
        await interaction.response.send_message(f"Dry-run mode set to {enabled}.", ephemeral=True)

    @archiveconfig.command(name="set-category", description="Set the category channels are moved into when archived.")
    @app_commands.describe(category="The destination category for archived channels.")
    async def set_category(self, interaction: discord.Interaction, category: discord.CategoryChannel) -> None:
        await asyncio.to_thread(
            self.db.update_guild_settings, interaction.guild_id, archive_category_id=category.id
        )
        await interaction.response.send_message(f"Archive category set to {category.name}.", ephemeral=True)

    @archiveconfig.command(name="set-log-channel", description="Set the channel scan summaries are posted to.")
    @app_commands.describe(channel="Text channel to receive scan summaries.")
    async def set_log_channel(self, interaction: discord.Interaction, channel: discord.TextChannel) -> None:
        await asyncio.to_thread(
            self.db.update_guild_settings, interaction.guild_id, log_channel_id=channel.id
        )
        await interaction.response.send_message(f"Log channel set to {channel.mention}.", ephemeral=True)

    @archiveconfig.command(name="exclude-add", description="Never auto-archive this channel.")
    @app_commands.describe(channel="Channel to exclude.")
    async def exclude_add(self, interaction: discord.Interaction, channel: discord.TextChannel) -> None:
        await asyncio.to_thread(self.db.add_excluded_channel, interaction.guild_id, channel.id)
        await interaction.response.send_message(f"{channel.mention} is now excluded from auto-archiving.", ephemeral=True)

    @archiveconfig.command(name="exclude-remove", description="Allow this channel to be auto-archived again.")
    @app_commands.describe(channel="Channel to remove from the exclude list.")
    async def exclude_remove(self, interaction: discord.Interaction, channel: discord.TextChannel) -> None:
        removed = await asyncio.to_thread(self.db.remove_excluded_channel, interaction.guild_id, channel.id)
        if removed:
            await interaction.response.send_message(f"{channel.mention} removed from the exclude list.", ephemeral=True)
        else:
            await interaction.response.send_message(f"{channel.mention} was not excluded.", ephemeral=True)

    @archiveconfig.command(name="scan-now", description="Run an auto-archive scan immediately.")
    async def scan_now(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        scanner = self.bot.get_cog("ScannerCog")
        if scanner is None:
            await interaction.followup.send("Scanner is not loaded.", ephemeral=True)
            return
        results = await scanner.run_scan_for_guild(interaction.guild)
        archived = [r for r in results if r.is_archived_or_would_be]
        errors = [r for r in results if r.action == "error"]
        await interaction.followup.send(
            f"Scan complete: {len(archived)} channel(s) archived/would-archive, {len(errors)} error(s).",
            ephemeral=True,
        )


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AdminCog(bot, bot.db))
