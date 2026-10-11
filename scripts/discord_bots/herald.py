"""Announcements — plain posts, reads like a human update."""
from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from .config import CHANNELS, GUILD_ID, admin_member
from .personalities import HERALD


class HeraldCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def _announce_channel(self, guild: discord.Guild) -> discord.TextChannel | None:
        return discord.utils.get(guild.text_channels, name=CHANNELS["announcements"])

    def _whats_new_channel(self, guild: discord.Guild) -> discord.TextChannel | None:
        return discord.utils.get(guild.text_channels, name=CHANNELS["whats-new"])

    @app_commands.command(name="announce", description="Post to #announcements")
    @app_commands.describe(
        title="Headline",
        body="Message (markdown ok)",
        ping_everyone="Ping @everyone",
    )
    async def announce(
        self,
        interaction: discord.Interaction,
        title: str,
        body: str,
        ping_everyone: bool = False,
    ):
        if not interaction.guild or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message("Guild only.", ephemeral=True)
            return
        if not admin_member(interaction.user):
            await interaction.response.send_message("Admins only.", ephemeral=True)
            return
        channel = self._announce_channel(interaction.guild)
        if not channel:
            await interaction.response.send_message("#announcements not found.", ephemeral=True)
            return
        text = f"**{title}**\n\n{body}"
        content = "@everyone\n" + text if ping_everyone else text
        await channel.send(content)
        await interaction.response.send_message("Posted.", ephemeral=True)

    @app_commands.command(name="release", description="Post What's New and a Claire announcement")
    @app_commands.describe(
        version="e.g. 2.4 (25)",
        highlights="Community changelog only (no Archive / Still open)",
    )
    async def release(self, interaction: discord.Interaction, version: str, highlights: str):
        if not interaction.guild or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message("Guild only.", ephemeral=True)
            return
        if not admin_member(interaction.user):
            await interaction.response.send_message("Admins only.", ephemeral=True)
            return
        announce = self._announce_channel(interaction.guild)
        whats_new = self._whats_new_channel(interaction.guild)
        if not announce:
            await interaction.response.send_message("#announcements not found.", ephemeral=True)
            return
        if not whats_new:
            await interaction.response.send_message("#whats-new not found.", ephemeral=True)
            return

        notes = highlights.strip()
        beta = "https://parlance-lang.github.io/ParlanceApp/beta.html"
        short_lines = [
            line for line in notes.splitlines()
            if line.strip().startswith(("-", "*"))
        ][:4]
        short = "\n".join(short_lines) if short_lines else notes.split("\n", 1)[0]
        whats_text = (
            f"**Parlance {version}**\n\n"
            f"{notes}\n\n"
            f"Join the beta on iPhone or Android: {beta}"
        )
        claire_text = (
            f"**Parlance {version}** is out.\n\n"
            f"{short}\n\n"
            "Testers: update in TestFlight or Google Play.\n"
            f"New testers: {beta}\n\n"
            "Full notes in #whats-new."
        )
        await whats_new.send(whats_text)
        await announce.send(claire_text)
        await interaction.response.send_message("Posted to #whats-new and #announcements.", ephemeral=True)

    @app_commands.command(name="testflight", description="Call for TestFlight testers")
    @app_commands.describe(build="Build label", notes="What to test", link="Invite URL")
    async def testflight(
        self,
        interaction: discord.Interaction,
        build: str,
        notes: str,
        link: str = "",
    ):
        if not interaction.guild or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message("Guild only.", ephemeral=True)
            return
        if not admin_member(interaction.user):
            await interaction.response.send_message("Admins only.", ephemeral=True)
            return
        channel = self._announce_channel(interaction.guild)
        if not channel:
            await interaction.response.send_message("#announcements not found.", ephemeral=True)
            return
        text = f"**TestFlight: {build}**\n\n{notes}"
        if link:
            text += f"\n\n{link}"
        text += "\n\nNew testers sign up here: https://parlance-lang.github.io/ParlanceApp/beta.html"
        text += "\n\nShare feedback in #beta-testers."
        await channel.send(text)
        await interaction.response.send_message("Posted.", ephemeral=True)


class HeraldBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.guilds = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        await self.add_cog(HeraldCog(self))
        guild = discord.Object(id=GUILD_ID)
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)

    async def on_ready(self):
        print(f"[{HERALD['name']}] online as {self.user}")


def create_herald_bot() -> HeraldBot:
    return HeraldBot()
