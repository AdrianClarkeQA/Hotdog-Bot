// Handles /coop: the co-op games list. Uses the same saved games as /gaming.
//
//   /coop set <game> <status>   anyone; status picked from a fixed list
//   /coop recommend             anyone; picks a random Ready game, posted publicly
//   /coop list [status]         anyone; shows the list (only the invoker sees it)
//
// Discord doesn't allow a command to mix subcommands (recommend) with plain
// options (<game> <status>), hence /coop set rather than /coop <game> <status>.

import { InteractionResponseType } from "discord-interactions";
import { tidyGameName, escapeMarkdown, MAX_GAME_LEN } from "./sessions.js";
import { setCoopStatus, listCoopGames } from "./games-db.js";

export const COOP_COMMANDS = ["coop"];

// Order here is the order /coop list shows them and the order of the picker.
export const COOP_STATUSES = {
  ready: { label: "Ready" },
  not_purchased: { label: "Not Purchased" },
  parked: { label: "Parked" },
  completed: { label: "Completed It Mate" },
};

// Discord messages max out at 2000 characters.
const MAX_MESSAGE = 2000;

export const statusText = (status) => COOP_STATUSES[status]?.label ?? status;

function reply(content, { ephemeral = true } = {}) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      // 64 = EPHEMERAL (only the invoker sees it), 4 = SUPPRESS_EMBEDS
      flags: ephemeral ? 64 : 4,
      allowed_mentions: { parse: [] }, // a game called "@everyone" pings no one
    },
  };
}

function opt(options, name) {
  return (options ?? []).find((o) => o.name === name)?.value;
}

// Picks one item at random. `random` is swappable for tests.
export function pickRandom(items, random = Math.random) {
  if (!items.length) return null;
  return items[Math.floor(random() * items.length)];
}

// The /coop list text: one section per status, games A–Z. Trims to fit
// Discord's message limit, saying how many were left off.
export function coopListMessage(rows, onlyStatus = null) {
  const statuses = onlyStatus ? [onlyStatus] : Object.keys(COOP_STATUSES);
  const lines = [];
  for (const status of statuses) {
    const games = rows.filter((r) => r.coop_status === status);
    if (!games.length && !onlyStatus) continue;
    lines.push(`**${statusText(status)}** (${games.length})`);
    lines.push(games.length ? games.map((g) => `• ${escapeMarkdown(g.name)}`).join("\n") : "_None yet_");
    lines.push("");
  }
  if (!lines.length) return "The co-op list is empty. Add a game with `/coop set`.";

  let text = lines.join("\n").trim();
  if (text.length > MAX_MESSAGE) {
    const cut = text.lastIndexOf("\n", MAX_MESSAGE - 40);
    const shown = text.slice(0, cut);
    const hidden = text.slice(cut).split("\n").filter((l) => l.startsWith("• ")).length;
    text = `${shown}\n…and ${hidden} more`;
  }
  return text;
}

export async function handleCoopCommand(interaction, env) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const sub = interaction.data.options?.[0];

  if (sub?.name === "set") {
    const game = tidyGameName(opt(sub.options, "game"));
    const status = opt(sub.options, "status");
    if (!game) return reply("Give the game a name.");
    if (game.length > MAX_GAME_LEN) return reply(`Game names can be up to ${MAX_GAME_LEN} characters.`);
    if (!COOP_STATUSES[status]) return reply("Pick a status from the list.");

    const { name, previous } = await setCoopStatus(env, game, status, userId);
    const shown = `**${escapeMarkdown(name)}**`;
    if (previous === status) return reply(`${shown} is already ${statusText(status)}.`);
    return reply(
      previous
        ? `${shown}: ${statusText(previous)} → ${statusText(status)}`
        : `${shown} added to the co-op list as ${statusText(status)}.`
    );
  }

  if (sub?.name === "recommend") {
    const ready = await listCoopGames(env, "ready");
    const pick = pickRandom(ready);
    if (!pick) {
      return reply("No games are marked Ready yet. Set one with `/coop set <game> Ready`.");
    }
    const outOf = ready.length === 1 ? "the only Ready game" : `picked from ${ready.length} Ready games`;
    return reply(`Co-op pick: **${escapeMarkdown(pick.name)}** (${outOf})`, { ephemeral: false });
  }

  if (sub?.name === "list") {
    const status = opt(sub.options, "status") ?? null;
    if (status && !COOP_STATUSES[status]) return reply("Pick a status from the list.");
    const rows = await listCoopGames(env, status);
    return reply(coopListMessage(rows, status));
  }

  return reply("Unknown subcommand.");
}
