// Worker entry point.
//  - fetch():     verifies + handles Discord interactions (slash commands,
//                 autocomplete, component clicks and pop-up form submissions)
//  - scheduled(): runs the archive/restore sweep on the cron trigger

import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
import { handleCommand, handleComponent } from "./commands.js";
import { handleGamingCommand, handleGamingAutocomplete, GAMING_COMMANDS } from "./gaming.js";
import {
  handleQuoteCommand,
  handleQuoteAutocomplete,
  handleQuoteComponent,
  handleQuoteModal,
  QUOTE_COMMANDS,
  QUOTE_PREFIX,
} from "./quotes.js";
import { handleCoopCommand, COOP_COMMANDS } from "./coop.js";
import { runSweep } from "./sweep.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    // Verify the request actually came from Discord.
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const raw = await request.text();

    const valid =
      signature &&
      timestamp &&
      (await verifyKey(raw, signature, timestamp, env.DISCORD_PUBLIC_KEY));

    if (!valid) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(raw);

    // Discord PING handshake.
    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      if (GAMING_COMMANDS.includes(interaction.data?.name)) {
        return json(await handleGamingCommand(interaction, env, ctx));
      }
      if (QUOTE_COMMANDS.includes(interaction.data?.name)) {
        return json(await handleQuoteCommand(interaction, env));
      }
      if (COOP_COMMANDS.includes(interaction.data?.name)) {
        return json(await handleCoopCommand(interaction, env, ctx));
      }
      const response = await handleCommand(interaction, env);
      return json(response);
    }

    // Suggestions while typing in an autocomplete option
    // (/gaming, /games and /coop game boxes; /quotes' who box).
    if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      if (QUOTE_COMMANDS.includes(interaction.data?.name)) {
        return json(await handleQuoteAutocomplete(interaction, env));
      }
      return json(await handleGamingAutocomplete(interaction, env));
    }

    // Button/select clicks: the /quote "who said it?" prompt (anyone), or the
    // /arc restore category picker (privileged role).
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      if (interaction.data?.custom_id?.startsWith(QUOTE_PREFIX)) {
        return json(await handleQuoteComponent(interaction, env));
      }
      return json(await handleComponent(interaction, env));
    }

    // Pop-up form submissions (the /quote "someone not in the server" name box).
    if (interaction.type === InteractionType.MODAL_SUBMIT) {
      return json(await handleQuoteModal(interaction, env));
    }

    return new Response("Unhandled interaction", { status: 400 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSweep(env));
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
  });
}
