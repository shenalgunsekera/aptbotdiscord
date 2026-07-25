import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  type Interaction,
} from 'discord.js';
import { CONFIG } from './config.js';
import { touchChannel } from './identity.js';
import { registerCommands } from './register-commands.js';
import { Notifier } from './notifier.js';
import * as start from './commands/start.js';
import * as deposit from './commands/deposit.js';
import * as withdraw from './commands/withdraw.js';
import * as reads from './commands/reads.js';
import * as admin from './commands/admin.js';
import { onReceiptMessage } from './commands/receipt.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  new Notifier(c).start();
});

// Receipts arrive as image messages in a player's ticket.
client.on(Events.MessageCreate, (msg) => { void onReceiptMessage(msg).catch((e) => console.error('[receipt]', e)); });

client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    if (i.channelId && (i.isChatInputCommand() || i.isMessageComponent() || i.isModalSubmit())) {
      await touchChannel(i.user.id, i.channelId).catch(() => {});
    }
    if (i.isChatInputCommand()) return void (await onSlash(i));
    if (i.isStringSelectMenu() || i.isButton() || i.isModalSubmit()) return void (await onComponent(i));
  } catch (err) {
    console.error('[discord] interaction error:', err);
    await replyError(i);
  }
});

async function onSlash(i: any): Promise<void> {
  switch (i.commandName) {
    case 'start': return void (await start.start(i));
    case 'deposit': return void (await deposit.deposit(i));
    case 'canceldeposit': return void (await deposit.cancelDeposit(i));
    case 'withdraw': return void (await withdraw.withdraw(i));
    case 'pending': return void (await reads.pending(i));
    case 'payments': return void (await reads.payments(i));
    case 'guide': return void (await reads.guide(i));
    case 'support': return void (await reads.support(i));
    case 'editplatform': case 'editclubs': case 'editdeposit': case 'editwithdraw':
      return void (await i.reply({ ephemeral: true, content: 'To change your setup for now, just tell our team here in your ticket — self-serve editing is coming soon.' }));
    case 'ping': return void (await i.reply({ ephemeral: true, content: '🏓 pong' }));
    default: await i.reply({ ephemeral: true, content: 'Unknown command.' });
  }
}

/** Route a component/modal interaction by its custom_id ("head:...:args"). */
async function onComponent(i: any): Promise<void> {
  const id: string = i.customId;
  const parts = id.split(':');
  const arg = parts[parts.length - 1]!;         // last segment (an id) for most
  const p2 = parts.slice(2).join(':');           // remainder after head:sub

  // ── onboarding ──
  if (id === 'ob:name') return void (await start.onName(i));
  if (id === 'ob:platforms') return void (await start.onPlatforms(i));
  if (id === 'ob:accounts') return void (await start.onAccounts(i));
  if (id.startsWith('ob:clubs:')) return void (await start.onClubs(i, parts[2]!));
  if (id === 'ob:methods') return void (await start.onMethods(i));
  if (id === 'ob:payoutm') return void (await start.onPayoutMethod(i));
  if (id === 'ob:payouth') return void (await start.onPayoutHandle(i));

  // ── deposit ──
  if (id === 'add:pf') return void (await deposit.onPlatform(i));
  if (id === 'add:club') return void (await deposit.onClub(i));
  if (id === 'add:m') return void (await deposit.onMethod(i));
  if (id === 'add:amt') return void (await deposit.onAmount(i));

  // ── withdraw ──
  if (id === 'out:pf') return void (await withdraw.onPlatform(i));
  if (id === 'out:club') return void (await withdraw.onClub(i));
  if (id === 'out:amtbtn') return void (await withdraw.onAmountBtn(i));
  if (id === 'out:amt') return void (await withdraw.onAmount(i));
  if (id === 'out:m') return void (await withdraw.onMethod(i));
  if (id === 'out:hbtn') return void (await withdraw.onHandleBtn(i));
  if (id === 'out:h') return void (await withdraw.onHandle(i));
  if (id.startsWith('wd:retract:')) return void (await withdraw.retract(i, arg));
  if (id.startsWith('wd:reduce:')) return void (await withdraw.reducePrompt(i, arg));
  if (id.startsWith('wd:reduceamt:')) return void (await withdraw.reduceConfirm(i, arg));

  // ── admin ──
  if (id.startsWith('pl:approve:')) return void (await admin.approve(i, arg));
  if (id.startsWith('fl:verify:')) return void (await admin.verify(i, arg));
  if (id.startsWith('lo:claim:')) return void (await admin.loaderClaim(i, arg));
  if (id.startsWith('lo:done:')) return void (await admin.loaderDone(i, parts[2]!, Number(parts[3])));
  if (id.startsWith('lo:fail:')) return void (await admin.loaderFail(i, arg));
  if (id.startsWith('lo:short:')) return void (await admin.loaderShort(i, arg));
  if (id.startsWith('lo:shortamt:')) return void (await admin.loaderShortAmount(i, arg));
  if (id.startsWith('wd:pay:')) return void (await admin.withdrawPay(i, arg));
  if (id.startsWith('wd:payref:')) return void (await admin.withdrawPayRef(i, arg));
  if (id.startsWith('sb:made:')) return void (await admin.sbMade(i, arg));
  if (id.startsWith('st:ok:')) return void (await admin.stripeOk(i, arg));
  if (id.startsWith('st:credit:')) return void (await admin.stripeCredit(i, arg));
  if (id.startsWith('st:creditamt:')) return void (await admin.stripeCreditAmount(i, arg));

  void p2;
  if (i.isRepliable()) await i.reply({ ephemeral: true, content: 'That control has expired — run the command again.' });
}

async function replyError(i: Interaction): Promise<void> {
  if (!('isRepliable' in i) || !i.isRepliable()) return;
  const body = { content: 'Something went wrong. Nothing was changed.', flags: MessageFlags.Ephemeral } as const;
  try { if (i.replied || i.deferred) await i.followUp(body); else await i.reply(body); } catch { /* gone */ }
}

async function main(): Promise<void> {
  await registerCommands();
  await client.login(CONFIG.token);
}
void main();
