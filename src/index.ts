import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  type Interaction,
} from 'discord.js';
import { CONFIG } from './config.js';
import { touchChannel } from './identity.js';
import { registerCommands } from './register-commands.js';
import * as startCmd from './commands/start.js';

/**
 * ClubGG union — Discord front-end.
 *
 * A persistent gateway client (unlike the Telegram bot's serverless webhook),
 * because we need to receive message attachments (receipts). Slash commands,
 * buttons, select menus and modals all arrive as interactions; receipts arrive
 * as messages in a player's ticket channel.
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — needed to read receipt uploads
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // Keep the player's ticket channel current on every touch.
    if (i.channelId && (i.isChatInputCommand() || i.isMessageComponent() || i.isModalSubmit())) {
      await touchChannel(i.user.id, i.channelId).catch(() => {});
    }

    if (i.isChatInputCommand()) return void (await onSlash(i.commandName, i));
    if (i.isModalSubmit()) return void (await route(i.customId, i));
    if (i.isStringSelectMenu()) return void (await route(i.customId, i));
    if (i.isButton()) return void (await route(i.customId, i));
  } catch (err) {
    console.error('[discord] interaction error:', err);
    await replyError(i);
  }
});

async function onSlash(name: string, i: any): Promise<void> {
  switch (name) {
    case 'start': return void (await startCmd.start(i));
    case 'ping': return void (await i.reply({ ephemeral: true, content: '🏓 pong' }));
    default: await i.reply({ ephemeral: true, content: 'Unknown command.' });
  }
}

/** Dispatch component/modal interactions by their custom_id prefix. */
async function route(customId: string, i: any): Promise<void> {
  if (customId === 'ob:name') return void (await startCmd.onName(i));
  if (customId === 'ob:platforms') return void (await startCmd.onPlatforms(i));
  // Future: ob:*, add:*, out:*, clubs:*, pl:* …
  await i.reply({ ephemeral: true, content: 'That control has expired — try the command again.' });
}

async function replyError(i: Interaction): Promise<void> {
  if (!('isRepliable' in i) || !i.isRepliable()) return;
  const body = { content: 'Something went wrong. Nothing was changed.', flags: MessageFlags.Ephemeral } as const;
  try {
    if (i.replied || i.deferred) await i.followUp(body);
    else await i.reply(body);
  } catch { /* interaction already gone */ }
}

async function main(): Promise<void> {
  await registerCommands();
  await client.login(CONFIG.token);
}

void main();
