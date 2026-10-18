// Game details from RAWG in Discord: the /games info card, the details box on
// /gaming posts, and the short italic "Metacritic 84" text used in
// the co-op list. Plus the /games info, link and refresh commands.
//
//   /games info <game>              anyone; posts the game's details card
//   /games link <game> <rawg link>  privileged role; fixes a wrong or missing match
//   /games refresh                  privileged role; looks up games with no match yet

import { InteractionResponseType } from "discord-interactions";
import { tidyGameName, escapeMarkdown, MAX_GAME_LEN } from "./sessions.js";
import { findGame, saveRawg, unmatchedGames, countUnchecked } from "./games-db.js";
import { hasRawg, findOnRawg, rawgDetails, slugFromLink, rawgPage } from "./rawg.js";
import { editOriginalReply } from "./discord.js";

// Embed accent colour (teal).
const COLOUR = 0x1d9e75;
const FOOTER = { text: "Data from RAWG" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Games /games refresh looks up per run. Keeps each run well inside
// Cloudflare's limit on outgoing requests per command (50 on the free plan).
export const REFRESH_BATCH = 20;
const MAX_DESCRIPTION = 350;

// "2020-05-13" -> "13 May 2020". Anything else is shown as it is.
export function formatReleased(released) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(released ?? "");
  if (!m) return released ?? null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// "*Metacritic 84*" (italic) for the co-op list. Empty when RAWG has no score.
// Playtime isn't shown anywhere: RAWG's averages aren't reliable enough.
export function statsText(row) {
  return row?.metacritic ? `*Metacritic ${row.metacritic}*` : "";
}

// Shortens RAWG's long description to a couple of sentences.
export function shortDescription(text, max = MAX_DESCRIPTION) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean || null;
  const cut = clean.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max / 2) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// The small details box under a /gaming post. Null if the game has no RAWG match.
export function sessionEmbed(row) {
  if (!row?.rawg_id) return null;
  const line = [
    row.metacritic ? `Metacritic ${row.metacritic}` : null,
    row.coop_modes,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    title: row.rawg_name ?? row.name,
    url: rawgPage(row.rawg_slug),
    color: COLOUR,
    ...(line ? { description: line } : {}),
    ...(row.image_url ? { thumbnail: { url: row.image_url } } : {}),
    footer: FOOTER,
  };
}

// The full /games info card. `game` is the RAWG details (rawgDetails);
// `coopStatus` is the game's label on our co-op list, if it's on it.
export function infoEmbed(game, coopStatus = null) {
  const field = (name, value) => (value ? { name, value: String(value).slice(0, 1024), inline: true } : null);
  const rating = game.rawg_rating
    ? `${game.rawg_rating} / 5${game.rawg_ratings_count ? ` (${game.rawg_ratings_count.toLocaleString("en-GB")})` : ""}`
    : null;
  const fields = [
    field("Metacritic", game.metacritic),
    field("RAWG rating", rating),
    field("Released", formatReleased(game.released)),
    field("Genres", game.genres),
    field("Platforms", game.platforms),
    field("Co-op", game.coop_modes),
    field("Where to buy", game.stores),
    field("Age rating", game.age_rating),
    field("On our co-op list", coopStatus),
  ].filter(Boolean);
  const description = shortDescription(game.description);
  return {
    title: game.rawg_name,
    url: rawgPage(game.rawg_slug),
    color: COLOUR,
    ...(description ? { description } : {}),
    fields,
    ...(game.extra_image ? { thumbnail: { url: game.extra_image } } : {}),
    ...(game.image_url ? { image: { url: game.image_url } } : {}),
    footer: FOOTER,
  };
}

function reply(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  };
}

// "Thinking…" reply: Discord waits up to 15 minutes for the real answer,
// instead of the usual 3 seconds. Private (flags 64) unless `public`.
function deferred(isPublic) {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: isPublic ? {} : { flags: 64 },
  };
}

const opt = (options, name) => (options ?? []).find((o) => o.name === name)?.value;

// Sends the real answer to a deferred reply. A failure is logged; Discord then
// shows "The application did not respond" in place of the answer.
async function finish(env, interaction, body) {
  try {
    await editOriginalReply(env, interaction, body);
  } catch (err) {
    console.error("Answering the deferred reply failed:", err.message);
  }
}

const NO_KEY = "Game details aren't set up yet. Ask an admin to add the `RAWG_API_KEY` secret.";

// /games info <game>. Saved games use their saved RAWG match (and get their
// saved details refreshed); anything else is searched for and not saved.
export function handleGameInfo(interaction, env, sub, { afterReply, coopLabel }) {
  const typed = tidyGameName(opt(sub.options, "game"));
  if (!typed) return reply("Give the game a name.");
  if (typed.length > MAX_GAME_LEN) return reply(`Game names can be up to ${MAX_GAME_LEN} characters.`);
  if (!hasRawg(env)) return reply(NO_KEY);

  afterReply(
    (async () => {
      const saved = await findGame(env, typed);
      const rawgId = saved?.rawg_id ?? (await findOnRawg(env, saved?.name ?? typed))?.rawg_id;
      const game = rawgId ? await rawgDetails(env, rawgId) : null;
      if (!game) {
        return finish(env, interaction, {
          content: `Couldn't find **${escapeMarkdown(saved?.name ?? typed)}** on RAWG. Check the spelling, or an admin can match it by hand with \`/games link\`.`,
        });
      }
      if (saved) {
        try {
          await saveRawg(env, saved.name_key, game);
        } catch (err) {
          console.error(`Saving RAWG details for "${saved.name}" failed:`, err.message);
        }
      }
      return finish(env, interaction, { embeds: [infoEmbed(game, coopLabel(saved?.coop_status))] });
    })()
  );
  return deferred(true);
}

// /games link <game> <rawg link>: sets which RAWG game a saved game is.
// `onChange(row)` runs after saving (refreshes the co-op list post).
export function handleGameLink(interaction, env, sub, { afterReply, onChange }) {
  const typed = tidyGameName(opt(sub.options, "game"));
  const slug = slugFromLink(opt(sub.options, "rawg"));
  if (!slug) return reply("Paste the game's RAWG page link, like `https://rawg.io/games/deep-rock-galactic`.");
  if (!hasRawg(env)) return reply(NO_KEY);

  afterReply(
    (async () => {
      const saved = await findGame(env, typed);
      if (!saved) return finish(env, interaction, { content: "That game isn't in the list." });
      const game = await rawgDetails(env, slug);
      if (!game) {
        return finish(env, interaction, { content: `RAWG has no game at \`${slug}\`. Check the link.` });
      }
      await saveRawg(env, saved.name_key, game);
      await onChange?.(saved, game);
      return finish(env, interaction, {
        content: `**${escapeMarkdown(saved.name)}** now uses RAWG's **${escapeMarkdown(game.rawg_name)}**.`,
        embeds: [sessionEmbed({ ...saved, ...game })],
      });
    })()
  );
  return deferred(false);
}

// /games refresh: looks up saved games that have no RAWG match yet, a batch
// at a time. `onDone(rows)` runs after with the games that were found.
export function handleGameRefresh(interaction, env, { afterReply, onDone }) {
  if (!hasRawg(env)) return reply(NO_KEY);

  afterReply(
    (async () => {
      const batch = await unmatchedGames(env, REFRESH_BATCH);
      if (!batch.length) {
        return finish(env, interaction, { content: "Every saved game already has its RAWG details." });
      }
      const found = [];
      const missed = [];
      for (const row of batch) {
        const summary = await findOnRawg(env, row.name);
        await saveRawg(env, row.name_key, summary);
        (summary ? found : missed).push(row);
      }
      if (found.length) await onDone?.(found);

      const left = await countUnchecked(env);
      const lines = [`Found RAWG details for ${found.length} of ${batch.length} games.`];
      if (missed.length) {
        lines.push(
          `Not found: ${missed.map((r) => `**${escapeMarkdown(r.name)}**`).join(", ")}. Match these by hand with \`/games link\`.`
        );
      }
      if (left > 0) lines.push(`${left} more still to check. Run \`/games refresh\` again.`);
      return finish(env, interaction, { content: lines.join("\n") });
    })()
  );
  return deferred(false);
}
