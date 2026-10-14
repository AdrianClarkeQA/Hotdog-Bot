// Worker entry point.
//  - fetch():     verifies + handles Discord interactions (slash commands)
//  - scheduled(): runs the archive/restore sweep on the cron trigger

import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
import { handleCommand, handleComponent } from "./commands.js";
import { runSweep } from "./sweep.js";

export default {
  async fetch(request, env) {
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
      const response = await handleCommand(interaction, env);
      return json(response);
    }

    // Button/select clicks, e.g. the /arc restore category picker.
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      return json(await handleComponent(interaction, env));
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
