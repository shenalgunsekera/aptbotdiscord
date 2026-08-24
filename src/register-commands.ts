import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';

/**
 * The player-facing slash commands. Mirrors the Telegram command set. Registered
 * to a single guild when DISCORD_GUILD_ID is set (instant), else globally.
 */
export const COMMANDS = [
  new SlashCommandBuilder().setName('start').setDescription('Set up your account'),
  new SlashCommandBuilder().setName('deposit').setDescription('Add money'),
  new SlashCommandBuilder().setName('canceldeposit').setDescription('Cancel your latest unpaid deposit'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Cash-out'),
  new SlashCommandBuilder().setName('cancelwithdraw').setDescription('Cancel a cash-out that has not been paid'),
  new SlashCommandBuilder().setName('addtowithdraw').setDescription('Add more to a cash-out already in the queue'),
  new SlashCommandBuilder().setName('pending').setDescription('Your pending cash-outs'),
  new SlashCommandBuilder().setName('withdrawalhistory').setDescription('Cash-outs paid to you & receipts'),
  new SlashCommandBuilder().setName('deposithistory').setDescription('Deposits you made & receipts'),
  new SlashCommandBuilder().setName('editplatform').setDescription('Add or remove ClubGG / Sportsbook'),
  new SlashCommandBuilder().setName('editclubs').setDescription('Change which clubs you play in'),
  new SlashCommandBuilder().setName('editdeposit').setDescription('Change how you deposit'),
  new SlashCommandBuilder().setName('editwithdraw').setDescription('Change how you get paid'),
  new SlashCommandBuilder().setName('support').setDescription('Message our team'),
  new SlashCommandBuilder().setName('stop').setDescription("Stop whatever you're in the middle of"),
  new SlashCommandBuilder().setName('guide').setDescription('What each command does'),
  new SlashCommandBuilder().setName('ping').setDescription('Health check'),
  // Admin-only, run in a player's ticket channel to control their cash-out.
  new SlashCommandBuilder().setName('pausewithdraw').setDescription('(admin) Take this player\'s cash-out out of the queue'),
  new SlashCommandBuilder().setName('resumewithdraw').setDescription('(admin) Put this player\'s cash-out back in the queue'),
  new SlashCommandBuilder().setName('adjust').setDescription('(admin) +amount grows the cash-out; -amount records a payment you made')
    .addNumberOption((o) => o.setName('amount').setDescription('e.g. 50 to add, or -50 to record a payment you made').setRequired(true))
    .addAttachmentOption((o) => o.setName('receipt').setDescription('Screenshot of the payment (required for a negative amount)')),
  new SlashCommandBuilder().setName('paymentchannel').setDescription('(admin) Make this channel the payments feed'),
  new SlashCommandBuilder().setName('adminchannel').setDescription('(admin) Make this channel the admin channel'),
  new SlashCommandBuilder().setName('setadmin').setDescription('(owner) Make someone an admin')
    .addUserOption((o) => o.setName('user').setDescription('Who to make an admin').setRequired(true))
    .addStringOption((o) => o.setName('email').setDescription('Their email — how they sign in to the website').setRequired(true))
    .addBooleanOption((o) => o.setName('owner').setDescription('Make them an owner instead of an admin')),
].map((c) => c.toJSON());

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  if (CONFIG.guildId) {
    await rest.put(Routes.applicationGuildCommands(CONFIG.appId, CONFIG.guildId), { body: COMMANDS });
    // Clear any GLOBAL copies. If the bot ever ran without DISCORD_GUILD_ID it
    // registered these commands globally too, and Discord then shows every one
    // twice — merging the option lists so /adjust sprouts duplicate `amount`
    // fields. Wiping the global scope leaves exactly one command per name.
    await rest.put(Routes.applicationCommands(CONFIG.appId), { body: [] }).catch(() => { /* nothing to clear */ });
    console.log(`[discord] registered ${COMMANDS.length} guild commands (cleared global scope)`);
  } else {
    await rest.put(Routes.applicationCommands(CONFIG.appId), { body: COMMANDS });
    console.log(`[discord] registered ${COMMANDS.length} global commands`);
  }
}

// `pnpm register` runs this file directly — actually (re)register when it does,
// so the duplicate-command fix can be applied without a full redeploy.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerCommands()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[discord] registration failed:', e); process.exit(1); });
}
