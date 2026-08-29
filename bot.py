"""Entry point: connects to Discord, wires up persistence, cogs, and command sync."""
from __future__ import annotations

import logging

import discord
from discord.ext import commands

from app.config import load_config
from app.db import Database

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("bot")

config = load_config()

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True


class ArchiveBot(commands.Bot):
    def __init__(self) -> None:
        super().__init__(command_prefix="!", intents=intents)
        self.default_config = config
        self.db = Database(config.db_path)

    async def setup_hook(self) -> None:
        await self.load_extension("app.cogs.scanner")
        await self.load_extension("app.cogs.admin")

        if self.default_config.dev_guild_id:
            guild = discord.Object(id=self.default_config.dev_guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            log.info("Synced slash commands to dev guild %s", self.default_config.dev_guild_id)
        else:
            await self.tree.sync()
            log.info("Synced slash commands globally")


bot = ArchiveBot()


@bot.event
async def on_ready() -> None:
    log.info("Logged in as %s (%s)", bot.user, bot.user.id if bot.user else "?")
    log.info("Connected to %d guild(s):", len(bot.guilds))
    for guild in bot.guilds:
        print(f"- {guild.name} ({guild.id})")


def main() -> None:
    bot.run(config.discord_token)


if __name__ == "__main__":
    main()
