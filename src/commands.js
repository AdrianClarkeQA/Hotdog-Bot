// Handles /arc slash-command interactions.

import {
  InteractionResponseType,
} from "discord-interactions";
import {
  setChannelEnabled,
  setChannelDays,
  setGlobalEnabled,
  getChannelConfig,
  allConfigs,
} from "./db.js";

function reply(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    // 64 = EPHEMERAL: only the invoker sees it.
    data: { content, flags: 64 },
  };
}

// Pull a named option out of a (possibly nested) options array.
function opt(options, name) {
  const found = (options ?? []).find((o) => o.name === name);
  return found ? found.value : undefined;
}

export async function handleCommand(interaction, env) {
  // Role gate: the invoker must hold the privileged role.
  const roles = interaction.member?.roles ?? [];
  if (!roles.includes(env.PRIVILEGED_ROLE_ID)) {
    return reply("⛔ You don't have permission to use this command.");
  }

  const sub = interaction.data.options?.[0];
  if (!sub) return reply("Unknown command.");

  switch (sub.name) {
    case "on": {
      const ch = opt(sub.options, "channel");
      await setChannelEnabled(env, ch, true);
      return reply(`✅ Monitoring enabled for <#${ch}>.`);
    }
    case "off": {
      const ch = opt(sub.options, "channel");
      await setChannelEnabled(env, ch, false);
      return reply(`✅ Monitoring disabled for <#${ch}>.`);
    }
    case "days": {
      const ch = opt(sub.options, "channel");
      const n = opt(sub.options, "n");
      if (n < 1) return reply("Days must be at least 1.");
      await setChannelDays(env, ch, n);
      return reply(`✅ <#${ch}> will archive after ${n} day(s) of inactivity.`);
    }
    case "status": {
      const ch = opt(sub.options, "channel");
      if (ch) {
        const cfg = await getChannelConfig(env, ch);
        if (!cfg) return reply(`<#${ch}> is not configured.`);
        return reply(
          `<#${ch}> — ${cfg.enabled ? "enabled" : "disabled"}, ` +
            `${cfg.days}d, ${cfg.is_archived ? "currently archived" : "active"}.`
        );
      }
      const all = await allConfigs(env);
      if (all.length === 0) return reply("No channels configured yet.");
      const lines = all.map(
        (c) =>
          `<#${c.channel_id}> — ${c.enabled ? "on" : "off"}, ${c.days}d` +
          (c.is_archived ? ", archived" : "")
      );
      return reply(lines.join("\n"));
    }
    case "all": {
      // /arc all <state:on|off>
      const state = opt(sub.options, "state");
      await setGlobalEnabled(env, state === "on");
      return reply(`✅ Global monitoring turned ${state}.`);
    }
    default:
      return reply("Unknown subcommand.");
  }
}
