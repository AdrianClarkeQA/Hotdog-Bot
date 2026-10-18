// Handles /gaming (post a planned session) and /games (manage the saved list),
// plus the autocomplete for their `game` options.
//
//   /gaming <date> <time> [game]   anyone; posts in GAMING_CHANNEL_ID
//     game is optional: left out, the post says the game is to be decided
//     date: tomorrow, Saturday, 25/10/2026 …  time: 21:00, 2100, 9pm …
//   /games info <game>             anyone; game details from RAWG (see game-info.js)
//   /games remove <game>           privileged role only
//   /games link <game> <rawg link> privileged role only
//   /games refresh                 privileged role only

import { InteractionResponseType } from "discord-interactions";
import {
  parseSessionTime,
  sessionMessage,
  tidyGameName,
  gameKey,
  escapeMarkdown,
  MAX_GAME_LEN,
} from "./sessions.js";
import { suggestGames, findGame, recordGame, removeGame, lookUpIfNew, MAX_SUGGESTIONS } from "./games-db.js";
import { postMessage, editMessage } from "./discord.js";
import { COOP_STATUSES, refreshCoopBoard, afterReply } from "./coop.js";
import { sessionEmbed, handleGameInfo, handleGameLink, handleGameRefresh } from "./game-info.js";

const COOP_LABELS = Object.fromEntries(Object.entries(COOP_STATUSES).map(([k, v]) => [k, v.label]));

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

// /games and /coop have subcommands; /gaming doesn't. Returns the options that hold `game`.
function gameOptions(interaction) {
  const top = interaction.data?.options ?? [];
  return interaction.data?.name === "gaming" ? top : top[0]?.options ?? [];
}

export async function handleGamingCommand(interaction, env, ctx) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;

  if (interaction.data.name === "gaming") {
    const options = interaction.data.options;
    // Optional: blank means the game is still to be decided.
    const game = tidyGameName(opt(options, "game") ?? "");
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
    const known = game ? await findGame(env, game) : null;
    const display = known?.name ?? game;

    // Known games with RAWG details get a details box under the post.
    const embed = sessionEmbed(known);
    let posted;
    try {
      posted = await postMessage(env, channelId, sessionMessage({ game: display, unix: when.unix, userId }), {
        embeds: embed ? [embed] : [],
      });
    } catch (err) {
      console.error(`Posting session to ${channelId} failed:`, err.message);
      return reply(`❌ Couldn't post in <#${channelId}>. Check Botdog can view and send messages there.`);
    }

    // Saving the game is a nice-to-have; the session is already posted.
    // No game means nothing to save.
    if (display) {
      try {
        await recordGame(env, display, userId);
      } catch (err) {
        console.error(`Saving game "${display}" failed:`, err.message);
      }
      // A game Botdog hasn't looked up before: find it on RAWG after replying,
      // then add the details box to the post.
      if (!embed && posted?.id) {
        afterReply(ctx, addDetailsToPost(env, display, channelId, posted.id));
      }
    }
    return reply(`✅ Posted in <#${channelId}> for <t:${when.unix}:F>.`);
  }

  const sub = interaction.data.options?.[0];
  const later = (promise) => afterReply(ctx, promise);

  // /games info is for everyone.
  if (sub?.name === "info") {
    return handleGameInfo(interaction, env, sub, {
      afterReply: later,
      coopLabel: (status) => (status ? COOP_LABELS[status] ?? status : null),
    });
  }

  // The rest of /games is admin only, like /arc.
  const roles = interaction.member?.roles ?? [];
  if (!roles.includes(env.PRIVILEGED_ROLE_ID)) {
    return reply("⛔ You don't have permission to use this command.");
  }
  if (sub?.name === "link") {
    return handleGameLink(interaction, env, sub, {
      afterReply: later,
      onChange: (row) =>
        row.coop_status ? refreshCoopBoard(env, `**${escapeMarkdown(row.name)}** details updated from RAWG`) : null,
    });
  }
  if (sub?.name === "refresh") {
    return handleGameRefresh(interaction, env, {
      afterReply: later,
      onDone: (rows) =>
        rows.some((r) => r.coop_status) ? refreshCoopBoard(env, "Game details updated from RAWG") : null,
    });
  }
  if (sub?.name === "remove") {
    const removed = await removeGame(env, opt(sub.options, "game"));
    // A game leaving the co-op list changes the list post too.
    if (removed?.coop_status) {
      afterReply(ctx, refreshCoopBoard(env, `**${escapeMarkdown(removed.name)}** removed`));
    }
    return removed
      ? reply(`🗑️ Removed **${escapeMarkdown(removed.name)}** from the game list.`)
      : reply("That game isn't in the list.");
  }
  return reply("Unknown subcommand.");
}

// Suggestions for the `game` box while someone types (/gaming, /games remove,
// /coop set). /coop shows each game's current co-op status next to its name.
export async function handleGamingAutocomplete(interaction, env) {
  const focused = gameOptions(interaction).find((o) => o.focused);
  const typed = tidyGameName(focused?.value ?? "");
  const command = interaction.data?.name;
  const sub = command === "games" ? interaction.data.options?.[0]?.name : null;
  // /games info can look up any game, saved or not.
  const allowNew = command === "gaming" || command === "coop" || sub === "info";

  let choices = [];
  try {
    const rows = await suggestGames(env, typed, MAX_SUGGESTIONS);
    choices = rows.map((r) => {
      const label =
        command === "coop" && r.coop_status ? `${r.name} · ${COOP_LABELS[r.coop_status] ?? r.coop_status}` : r.name;
      return { name: label.slice(0, MAX_GAME_LEN), value: r.name };
    });

    // On /gaming and /coop, offer what's typed as a new game unless it's already saved.
    const key = gameKey(typed);
    if (allowNew && key && !rows.some((r) => r.name_key === key)) {
      const value = typed.slice(0, MAX_GAME_LEN);
      choices = choices.slice(0, MAX_SUGGESTIONS - 1);
      const prefix = sub === "info" ? "Look up: " : command === "coop" ? "New game: " : "➕ New game: ";
      choices.push({ name: `${prefix}${value}`.slice(0, MAX_GAME_LEN), value });
    }
  } catch (err) {
    console.error("Game autocomplete failed:", err.message);
  }

  return {
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  };
}

// Looks a newly saved game up on RAWG and, if found, adds the details box to
// the session post. Errors are logged: the post is already up either way.
async function addDetailsToPost(env, name, channelId, messageId) {
  try {
    const row = await lookUpIfNew(env, name);
    const embed = sessionEmbed(row);
    // flags 0 lifts SUPPRESS_EMBEDS, set when the post went up without details.
    if (embed) await editMessage(env, channelId, messageId, { embeds: [embed], flags: 0 });
  } catch (err) {
    console.error(`Adding RAWG details for "${name}" failed:`, err.message);
  }
}
