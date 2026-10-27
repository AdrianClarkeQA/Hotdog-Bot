// Handles /gaming (create a session event) and /games (manage the saved list),
// plus the autocomplete for their `game` options.
//
//   /gaming <date> <time> [game]   anyone; creates a voice event in
//     VOICE_CHANNEL_ID and posts its link in GAMING_CHANNEL_ID (see events.js)
//     game is optional: left out, the event gets a "game to be decided" title
//     date: tomorrow, Saturday, 25/10/2026 …  time: 21:00, 2100, 9pm …
//   /games info <game>             anyone; game details from RAWG (see game-info.js)
//   /games remove <game>           privileged role only
//   /games link <game> <rawg link> privileged role only
//   /games refresh                 privileged role only

import { InteractionResponseType } from "discord-interactions";
import { parseSessionTime, tidyGameName, gameKey, escapeMarkdown, MAX_GAME_LEN } from "./sessions.js";
import { suggestGames, findGame, recordGame, removeGame, saveRawg, MAX_SUGGESTIONS } from "./games-db.js";
import { postMessage, createScheduledEvent } from "./discord.js";
import { COOP_STATUSES, refreshCoopBoard, afterReply } from "./coop.js";
import { handleGameInfo, handleGameLink, handleGameRefresh, deferred, finish } from "./game-info.js";
import { hasRawg, findOnRawg } from "./rawg.js";
import {
  pickTitle,
  eventDescription,
  fetchCoverImage,
  eventBody,
  eventLink,
  lastTitleTemplate,
  recordSessionPost,
} from "./events.js";

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

    if (!env.GAMING_CHANNEL_ID) {
      return reply("No gaming channel is set up yet. Ask an admin to set `GAMING_CHANNEL_ID`.");
    }
    if (!env.VOICE_CHANNEL_ID) {
      return reply("No voice channel is set up for events yet. Ask an admin to set `VOICE_CHANNEL_ID`.");
    }

    // Looking up RAWG, downloading the cover and creating the event can take
    // longer than Discord's 3 seconds, so answer "thinking…" (only the
    // invoker sees it) and fill the answer in when it's done.
    afterReply(ctx, createSession(env, interaction, { game, unix: when.unix, userId }));
    return deferred(false);
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

// Why Discord refused to create the event, in words fit for the reply.
function eventError(err, voiceId) {
  if (err.status === 403) {
    return (
      `Botdog doesn't have permission to create events in <#${voiceId}>. ` +
      "Give Botdog's role Create Events, View Channel and Connect on that channel. Nothing was posted."
    );
  }
  if (err.status === 404) {
    return "Discord couldn't find the voice channel set in `VOICE_CHANNEL_ID`. Check the ID. Nothing was posted.";
  }
  return `Discord wouldn't create the event (error ${err.status ?? "unknown"}). Nothing was posted.`;
}

// The work behind /gaming, run after the "thinking…" reply:
//  1. find the game's RAWG details (saved, or looked up now for a new game)
//  2. create the voice event with a random title, the RAWG cover and description
//  3. post the event link in the gaming channel and save the post for the
//     nightly clean-up
// The game is only saved to the list once the event is up and posted.
async function createSession(env, interaction, { game, unix, userId }) {
  const say = (content) => finish(env, interaction, { content });
  const voiceId = env.VOICE_CHANNEL_ID;
  const chatId = env.GAMING_CHANNEL_ID;

  try {
    // Checks the session_posts table exists before anything is created, so an
    // event can't be posted that the clean-up doesn't know about.
    let last;
    try {
      last = await lastTitleTemplate(env);
    } catch (err) {
      console.error("Reading session_posts failed:", err.message);
      return say(
        "Botdog's database needs updating before `/gaming` can make events. " +
          "Ask an admin to run `npm run db:migrate:events`. Nothing was posted."
      );
    }

    // Game details. A game RAWG hasn't been asked about yet is looked up now,
    // so even its first event gets a cover. findOnRawg returns null on errors.
    const known = game ? await findGame(env, game) : null;
    const display = known?.name ?? game;
    const found = display && !known?.rawg_checked_at && hasRawg(env) ? await findOnRawg(env, display) : null;
    const details = found ? { ...known, name: display, ...found } : known;

    const { template, name } = pickTitle(display, { last });
    const description = eventDescription(details);
    const image = details?.rawg_id ? await fetchCoverImage(details.image_url) : null;

    let event;
    try {
      event = await createScheduledEvent(env, eventBody({ name, unix, channelId: voiceId, description, image }));
    } catch (err) {
      // A cover Discord won't take shouldn't stop the session: try once without it.
      if (!image || err.status !== 400) {
        console.error("Creating the event failed:", err.message);
        return say(eventError(err, voiceId));
      }
      console.error("Creating the event with a cover failed, retrying without:", err.message);
      try {
        event = await createScheduledEvent(env, eventBody({ name, unix, channelId: voiceId, description }));
      } catch (err2) {
        console.error("Creating the event failed:", err2.message);
        return say(eventError(err2, voiceId));
      }
    }

    const link = eventLink(env.GUILD_ID, event.id);
    let posted;
    try {
      posted = await postMessage(env, chatId, link, { unfurl: true });
      if (!posted?.id) throw new Error(`no message returned when posting in ${chatId}`);
    } catch (err) {
      console.error(`Posting the event link in ${chatId} failed:`, err.message);
      return say(
        `The event is created, but Botdog couldn't post it in <#${chatId}>. ` +
          `Check Botdog can view and send messages there. Event link: ${link}`
      );
    }

    // Saving the game and its RAWG details is a nice-to-have; the session is up.
    if (display) {
      try {
        const saved = await recordGame(env, display, userId);
        if (!known?.rawg_checked_at && hasRawg(env)) await saveRawg(env, gameKey(saved), found);
      } catch (err) {
        console.error(`Saving game "${display}" failed:`, err.message);
      }
    }

    let untracked = "";
    try {
      await recordSessionPost(env, {
        messageId: posted.id,
        channelId: chatId,
        eventId: event.id,
        startsAt: unix * 1000,
        titleTemplate: template,
        userId,
      });
    } catch (err) {
      console.error(`Saving session post ${posted.id} failed:`, err.message);
      untracked = " It won't be removed from the channel automatically, so delete it by hand after the session.";
    }

    return say(`Event created for <t:${unix}:F> and posted in <#${chatId}>.${untracked}`);
  } catch (err) {
    console.error("/gaming failed:", err.message);
    return say("Something went wrong setting up the session. Check whether the event appeared before trying again.");
  }
}
