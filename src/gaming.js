// Handles /gaming (post a planned session) and /games (manage the saved list),
// plus the autocomplete for their `game` options.
//
//   /gaming <game> <date> <time>   anyone; posts in GAMING_CHANNEL_ID
//     date: tomorrow, Saturday, 25/10/2026 …  time: 21:00, 2100, 9pm …
//   /games remove <game>           privileged role only

import { InteractionResponseType } from "discord-interactions";
import {
  parseSessionTime,
  sessionMessage,
  tidyGameName,
  gameKey,
  escapeMarkdown,
  MAX_GAME_LEN,
} from "./sessions.js";
import { suggestGames, findGame, recordGame, removeGame, MAX_SUGGESTIONS } from "./games-db.js";
import { postMessage } from "./discord.js";

export const GAMING_COMMANDS = ["gaming", "games"];

function reply(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 }, // 64 = EPHEMERAL: only the invoker sees it
  };
}

function opt(options, name) {
  return (options ?? []).find((o) => o.name === name)?.value;
}

// /games has subcommands; /gaming doesn't. Returns the options that hold `game`.
function gameOptions(interaction) {
  const top = interaction.data?.options ?? [];
  return interaction.data?.name === "games" ? top[0]?.options ?? [] : top;
}

export async function handleGamingCommand(interaction, env) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;

  if (interaction.data.name === "gaming") {
    const options = interaction.data.options;
    const game = tidyGameName(opt(options, "game"));
    if (!game) return reply("Give the game a name.");
    if (game.length > MAX_GAME_LEN) return reply(`Game names can be up to ${MAX_GAME_LEN} characters.`);

    const when = parseSessionTime(opt(options, "date"), opt(options, "time"), {
      timeZone: env.TIMEZONE || "Europe/London",
    });
    if (when.error) return reply(when.error);

    const channelId = env.GAMING_CHANNEL_ID;
    if (!channelId) {
      return reply("⚠️ No gaming channel is set up yet. Ask an admin to set `GAMING_CHANNEL_ID`.");
    }

    // Use the saved spelling if this game is already known.
    const known = await findGame(env, game);
    const display = known?.name ?? game;

    try {
      await postMessage(env, channelId, sessionMessage({ game: display, unix: when.unix, userId }));
    } catch (err) {
      console.error(`Posting session to ${channelId} failed:`, err.message);
      return reply(`❌ Couldn't post in <#${channelId}>. Check Botdog can view and send messages there.`);
    }

    // Saving the game is a nice-to-have; the session is already posted.
    try {
      await recordGame(env, display, userId);
    } catch (err) {
      console.error(`Saving game "${display}" failed:`, err.message);
    }
    return reply(`✅ Posted in <#${channelId}> for <t:${when.unix}:F>.`);
  }

  // /games — admin only, like /arc.
  const roles = interaction.member?.roles ?? [];
  if (!roles.includes(env.PRIVILEGED_ROLE_ID)) {
    return reply("⛔ You don't have permission to use this command.");
  }
  const sub = interaction.data.options?.[0];
  if (sub?.name === "remove") {
    const removed = await removeGame(env, opt(sub.options, "game"));
    return removed
      ? reply(`🗑️ Removed **${escapeMarkdown(removed.name)}** from the game list.`)
      : reply("That game isn't in the list.");
  }
  return reply("Unknown subcommand.");
}

// Suggestions for the `game` box while someone types.
export async function handleGamingAutocomplete(interaction, env) {
  const focused = gameOptions(interaction).find((o) => o.focused);
  const typed = tidyGameName(focused?.value ?? "");
  const allowNew = interaction.data?.name === "gaming";

  let choices = [];
  try {
    const rows = await suggestGames(env, typed, MAX_SUGGESTIONS);
    choices = rows.map((r) => ({ name: r.name, value: r.name }));

    // On /gaming, offer what's typed as a new game unless it's already saved.
    const key = gameKey(typed);
    if (allowNew && key && !rows.some((r) => r.name_key === key)) {
      const value = typed.slice(0, MAX_GAME_LEN);
      choices = choices.slice(0, MAX_SUGGESTIONS - 1);
      choices.push({ name: `➕ New game: ${value}`.slice(0, MAX_GAME_LEN), value });
    }
  } catch (err) {
    console.error("Game autocomplete failed:", err.message);
  }

  return {
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  };
}
