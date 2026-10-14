// Handles /arc slash-command interactions.

import {
  InteractionResponseType,
} from "discord-interactions";
import {
  setChannelEnabled,
  setChannelDays,
  setGlobalEnabled,
  getChannelConfig,
  defaultDays,
  markRestored,
} from "./db.js";
import { effectiveChannels } from "./coverage.js";
import { getChannel, moveChannel } from "./discord.js";

const CATEGORY = 4;

// Discord rejects messages over 2000 characters.
const MAX_LEN = 2000;

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
        if (!cfg) {
          return reply(`<#${ch}> — on, ${defaultDays(env)}d (default).`);
        }
        return reply(
          `<#${ch}> — ${cfg.enabled ? "on" : "off"}, ` +
            `${cfg.days}d, ${cfg.is_archived ? "currently archived" : "active"}.`
        );
      }
      const all = await effectiveChannels(env);
      if (all.length === 0) return reply("No text channels found.");
      const lines = all.map(
        ({ channel, cfg, enabled, days, isDefault }) =>
          `<#${channel.id}> — ${enabled ? "on" : "off"}, ${days}d` +
          (isDefault ? " (default)" : "") +
          (cfg?.is_archived ? ", archived" : "")
      );
      let out = "";
      for (let i = 0; i < lines.length; i++) {
        const more = `\n…and ${lines.length - i} more`;
        if (out.length + lines[i].length + 1 + more.length > MAX_LEN) {
          out += more;
          break;
        }
        out += (out ? "\n" : "") + lines[i];
      }
      return reply(out);
    }
    case "all": {
      // /arc all <state:on|off>
      const state = opt(sub.options, "state");
      await setGlobalEnabled(env, state === "on");
      return reply(`✅ Global monitoring turned ${state}.`);
    }
    case "restore": {
      // /arc restore <channel> — move an archived channel back to the
      // category it was archived from. Usable from any channel.
      const ch = opt(sub.options, "channel");
      try {
        return reply(await restoreChannel(env, ch));
      } catch (err) {
        console.error(`Restore ${ch} failed:`, err.message);
        return reply(`❌ Couldn't restore <#${ch}>. Check the bot still has Manage Channels.`);
      }
    }
    default:
      return reply("Unknown subcommand.");
  }
}

// Moves an archived channel back to its original category and returns the
// reply text. Only channels Botdog archived itself can be restored, since
// those are the only ones with a recorded home.
async function restoreChannel(env, channelId) {
  const channel = await getChannel(env, channelId);
  if (!channel?.id) return "That channel no longer exists.";

  if (channel.parent_id !== env.ARCHIVE_CATEGORY_ID) {
    return `<#${channelId}> isn't in the archive category, so there's nothing to restore.`;
  }

  const cfg = await getChannelConfig(env, channelId);
  if (!cfg?.is_archived) {
    return (
      `<#${channelId}> is in the archive, but Botdog didn't put it there, ` +
      "so I don't know which category it belongs in. Move it manually."
    );
  }

  // The original category may have been deleted since archiving.
  let dest = cfg.original_parent_id ?? null;
  let destName = "no category";
  let note = "";
  if (dest) {
    const parent = await getChannel(env, dest);
    if (parent?.id && parent.type === CATEGORY) {
      destName = `**${parent.name}**`;
    } else {
      dest = null;
      note = " Its original category no longer exists, so it's now outside any category.";
    }
  }

  await moveChannel(env, channelId, dest);
  await markRestored(env, channelId);
  return (
    `✅ Restored <#${channelId}> to ${destName}.${note} ` +
    `It won't be re-archived for at least ${cfg.days} day(s).`
  );
}
