import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { CONFIG } from './config.js';

/**
 * The player-facing slash commands. Mirrors the Telegram command set. Registered
 * to a single guild when DISCORD_GUILD_ID is set (instant), else globally.
 */
export const COMMANDS = [
  new SlashCommandBuilder().setName('start').setDescription('Set up your account'),
  new SlashCommandBuilder().setName('deposit').setDescription('Add money'),
  new SlashCommandBuilder().setName('canceldeposit').setDescription('Cancel your latest unpaid deposit'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Cash out'),
  new SlashCommandBuilder().setName('pending').setDescription('Your pending cash-outs'),
  new SlashCommandBuilder().setName('payments').setDescription('Completed payments & receipts'),
  new SlashCommandBuilder().setName('editplatform').setDescription('Add or remove ClubGG / Sportsbook'),
  new SlashCommandBuilder().setName('editclubs').setDescription('Change which clubs you play in'),
  new SlashCommandBuilder().setName('editdeposit').setDescription('Change how you deposit'),
  new SlashCommandBuilder().setName('editwithdraw').setDescription('Change how you get paid'),
  new SlashCommandBuilder().setName('support').setDescription('Message our team'),
  new SlashCommandBuilder().setName('guide').setDescription('What each command does'),
  new SlashCommandBuilder().setName('ping').setDescription('Health check'),
  // Admin-only, run in a player's ticket channel to correct their cash out.
  new SlashCommandBuilder().setName('add').setDescription('(admin) Add to this player\'s cash out')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount to add, e.g. 20').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why (optional)')),
  new SlashCommandBuilder().setName('remove').setDescription('(admin) Remove from this player\'s cash out')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount to remove, e.g. 20').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why (optional)')),
].map((c) => c.toJSON());

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  if (CONFIG.guildId) {
    await rest.put(Routes.applicationGuildCommands(CONFIG.appId, CONFIG.guildId), { body: COMMANDS });
    console.log(`[discord] registered ${COMMANDS.length} guild commands`);
  } else {
    await rest.put(Routes.applicationCommands(CONFIG.appId), { body: COMMANDS });
    console.log(`[discord] registered ${COMMANDS.length} global commands`);
  }
}
