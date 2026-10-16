// Quotes: save funny lines and look them up later. Anyone can use these.
//
//   /quote <text>        asks "who said it?" (member picker, or type a name for
//                        someone not in the server), then posts in QUOTES_CHANNEL_ID
//   /quotes <who>        shows that person's last 3 quotes where it's typed
//   Apps → Save as quote right-click a message: posts it straight away, credited
//                        to whoever wrote it, with a link back to the original

import { InteractionResponseType } from "discord-interactions";
import { escapeMarkdown } from "./sessions.js";
import { postMessage } from "./discord.js";
import {
  createPendingQuote,
  getQuote,
  claimPendingQuote,
  unclaimQuote,
  deleteQuote,
  insertPostedQuote,
  findQuoteBySource,
  suggestSpeakers,
  resolveSpeaker,
  latestQuotes,
  tidyName,
  nameKey,
  userKey,
} from "./quotes-db.js";

export const SAVE_AS_QUOTE = "Save as quote";
export const QUOTE_COMMANDS = ["quote", "quotes", SAVE_AS_QUOTE];
export const QUOTE_PREFIX = "quote-"; // custom_id prefix for the "who said it?" prompt

export const MAX_QUOTE_LEN = 1000;
export const MAX_NAME_LEN = 80;
const SHOW_COUNT = 3;
const SHOW_CLIP = 500; // /quotes trims each quote so three always fit in one message
const MAX_MESSAGE = 2000;

const EPHEMERAL = 64;

function reply(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  };
}

// Replaces the private "who said it?" prompt with a result.
function update(content) {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { content, components: [], allowed_mentions: { parse: [] } },
  };
}

const invoker = (interaction) => interaction.member?.user?.id ?? interaction.user?.id;

function opt(options, name) {
  return (options ?? []).find((o) => o.name === name)?.value;
}

// Quote text keeps its line breaks; markdown characters show as typed rather
// than formatting, and lines can't turn into headings, lists or block quotes.
function escapeQuote(text) {
  return escapeMarkdown(text).replace(/^(\s*)([#>-])/gm, "$1\\$2");
}

function tidyQuote(raw) {
  return String(raw ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "") // the post adds its own quotation marks
    .trim();
}

// How a speaker is shown: a member mention (shows their current name, never
// pings), or the typed name in bold.
function speakerLabel(s) {
  const id = s.speaker_id ?? s.id;
  return id ? `<@${id}>` : `**${escapeMarkdown(s.speaker_name ?? s.name)}**`;
}

// Who saved a quote is stored (added_by) but not shown.
export function quoteMessage({ text, speaker, sourceUrl }) {
  return (
    `💬 “${escapeQuote(text)}”\n— ${speakerLabel(speaker)}` +
    (sourceUrl ? `\n-# [original message](${sourceUrl})` : "")
  );
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

export function quotesListMessage(speaker, quotes) {
  const who = speakerLabel(speaker);
  const heading =
    quotes.length === 1 ? `💬 The only quote from ${who} so far:` : `💬 Last ${quotes.length} quotes from ${who}:`;
  const blocks = quotes.map(
    (q) => `“${escapeQuote(clip(q.text, SHOW_CLIP))}”\n-# <t:${Math.floor(q.created_at / 1000)}:D>`
  );
  return [heading, ...blocks].join("\n\n");
}

async function post(env, content) {
  return postMessage(env, env.QUOTES_CHANNEL_ID, content);
}

function noChannel() {
  return reply("⚠️ No quotes channel is set up yet. Ask an admin to set `QUOTES_CHANNEL_ID`.");
}

export async function handleQuoteCommand(interaction, env) {
  const userId = invoker(interaction);
  const name = interaction.data?.name;

  if (name === "quotes") return showQuotes(interaction, env);

  if (!env.QUOTES_CHANNEL_ID) return noChannel();

  if (name === SAVE_AS_QUOTE) return saveMessageAsQuote(interaction, env, userId);

  // /quote <text>: store it, then ask who said it.
  const text = tidyQuote(opt(interaction.data.options, "text"));
  if (!text) return reply("Type the quote to save.");
  if (text.length > MAX_QUOTE_LEN) return reply(`Quotes can be up to ${MAX_QUOTE_LEN} characters.`);

  const id = await createPendingQuote(env, text, userId);
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
      content: `💬 “${escapeQuote(clip(text, 300))}”\n\nWho said it?`,
      components: [
        {
          type: 1, // action row
          components: [
            {
              type: 5, // user select: server members
              custom_id: `${QUOTE_PREFIX}who:${id}`,
              placeholder: "Pick a server member",
            },
          ],
        },
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: "Someone not in the server", custom_id: `${QUOTE_PREFIX}name:${id}` },
            { type: 2, style: 4, label: "Cancel", custom_id: `${QUOTE_PREFIX}cancel:${id}` },
          ],
        },
      ],
    },
  };
}

// Right-click a message → Apps → Save as quote.
async function saveMessageAsQuote(interaction, env, userId) {
  const targetId = interaction.data?.target_id;
  const message = interaction.data?.resolved?.messages?.[targetId];
  if (!message) return reply("Couldn't read that message.");

  const text = tidyQuote(message.content);
  if (!text) return reply("That message has no text to quote.");
  if (text.length > MAX_QUOTE_LEN) return reply(`Quotes can be up to ${MAX_QUOTE_LEN} characters.`);

  const guildId = interaction.guild_id ?? env.GUILD_ID;
  const channelId = message.channel_id ?? interaction.channel_id;
  const sourceUrl = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
  if (await findQuoteBySource(env, sourceUrl)) {
    return reply(`That message is already saved in <#${env.QUOTES_CHANNEL_ID}>.`);
  }

  const author = message.author ?? {};
  const nick = interaction.data?.resolved?.members?.[author.id]?.nick;
  const speaker = {
    id: author.id,
    name: nick || author.global_name || author.username || "Unknown",
    key: userKey(author.id),
  };

  const content = quoteMessage({ text, speaker, sourceUrl });
  if (content.length > MAX_MESSAGE) return reply("That message is too long to post as a quote.");

  try {
    await post(env, content);
  } catch (err) {
    console.error(`Posting quote to ${env.QUOTES_CHANNEL_ID} failed:`, err.message);
    return reply(`❌ Couldn't post in <#${env.QUOTES_CHANNEL_ID}>. Check Botdog can view and send messages there.`);
  }
  await insertPostedQuote(env, { text, speaker, addedBy: userId, sourceUrl });
  return reply(`✅ Quote saved in <#${env.QUOTES_CHANNEL_ID}>.`);
}

// /quotes <who>: last 3 quotes, posted where it's typed for everyone to see.
async function showQuotes(interaction, env) {
  const value = opt(interaction.data.options, "who");
  const speaker = await resolveSpeaker(env, value);
  if (!speaker) {
    return reply(`No quotes from **${escapeMarkdown(tidyName(value) || "them")}** yet.`);
  }
  const quotes = await latestQuotes(env, speaker.speaker_key, SHOW_COUNT);
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: quotesListMessage(speaker, quotes),
      allowed_mentions: { parse: [] },
      flags: 4, // SUPPRESS_EMBEDS
    },
  };
}

// Suggestions for /quotes' `who` box: everyone who's been quoted.
export async function handleQuoteAutocomplete(interaction, env) {
  const focused = (interaction.data?.options ?? []).find((o) => o.focused);
  let choices = [];
  try {
    const rows = await suggestSpeakers(env, focused?.value ?? "");
    choices = rows.map((r) => ({
      name: `${r.speaker_name} (${r.n} quote${r.n === 1 ? "" : "s"})`.slice(0, 100),
      value: r.speaker_key.slice(0, 100),
    }));
  } catch (err) {
    console.error("Quote autocomplete failed:", err.message);
  }
  return {
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  };
}

// Loads the waiting quote named in a custom_id, checking it's still waiting
// and belongs to whoever clicked.
async function pendingFrom(interaction, env, id) {
  const quote = await getQuote(env, Number(id));
  if (!quote || quote.posted) return { error: "This quote has already been posted or was discarded." };
  if (quote.added_by && quote.added_by !== invoker(interaction)) {
    return { error: "Only the person who ran /quote can finish it." };
  }
  return { quote };
}

// Claims the waiting quote for this speaker and posts it.
async function finishQuote(env, quote, speaker) {
  const claimed = await claimPendingQuote(env, quote.id, speaker);
  if (!claimed) return update("This quote has already been posted.");

  const content = quoteMessage({ text: quote.text, speaker });
  try {
    if (content.length > MAX_MESSAGE) throw new Error("quote too long once formatted");
    await post(env, content);
  } catch (err) {
    console.error(`Posting quote ${quote.id} failed:`, err.message);
    await unclaimQuote(env, quote.id);
    return update(`❌ Couldn't post in <#${env.QUOTES_CHANNEL_ID}>. Check Botdog can view and send messages there, then run /quote again.`);
  }
  return update(`✅ Quote posted in <#${env.QUOTES_CHANNEL_ID}>.`);
}

// Clicks on the "who said it?" prompt.
export async function handleQuoteComponent(interaction, env) {
  const [, action, id] = /^quote-(\w+):(\d+)$/.exec(interaction.data?.custom_id ?? "") ?? [];
  if (!action) return update("Unknown action.");

  const { quote, error } = await pendingFrom(interaction, env, id);
  if (error) return update(error);

  if (action === "cancel") {
    await deleteQuote(env, quote.id);
    return update("Quote discarded.");
  }

  if (action === "name") {
    return {
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `${QUOTE_PREFIX}modal:${quote.id}`,
        title: "Who said it?",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4, // text input
                custom_id: "name",
                label: "Their name",
                style: 1, // single line
                min_length: 1,
                max_length: MAX_NAME_LEN,
                required: true,
              },
            ],
          },
        ],
      },
    };
  }

  if (action === "who") {
    const userId = interaction.data.values?.[0];
    if (!userId) return update("Nobody picked.");
    const resolved = interaction.data.resolved ?? {};
    const user = resolved.users?.[userId] ?? {};
    const nick = resolved.members?.[userId]?.nick;
    return finishQuote(env, quote, {
      id: userId,
      name: nick || user.global_name || user.username || "Unknown",
      key: userKey(userId),
    });
  }

  return update("Unknown action.");
}

// Finds a text input's value in a modal submission, whatever the nesting.
function modalValue(components, customId) {
  for (const c of components ?? []) {
    if (c.custom_id === customId && c.value !== undefined) return c.value;
    const inner = modalValue(c.components ?? (c.component ? [c.component] : []), customId);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

// The typed name for someone not in the server.
export async function handleQuoteModal(interaction, env) {
  const [, id] = /^quote-modal:(\d+)$/.exec(interaction.data?.custom_id ?? "") ?? [];
  if (!id) return update("Unknown action.");

  const { quote, error } = await pendingFrom(interaction, env, id);
  if (error) return update(error);

  const name = tidyName(modalValue(interaction.data.components, "name")).slice(0, MAX_NAME_LEN);
  if (!name) return update("No name given — run /quote again.");

  return finishQuote(env, quote, { id: null, name, key: nameKey(name) });
}
