import { createServer } from 'node:http';
import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  type Interaction, type Message,
} from 'discord.js';
import { CONFIG } from './config.js';
import { ses } from './session.js';
import { registerCommands } from './register-commands.js';
import { Notifier } from './notifier.js';
import * as start from './commands/start.js';
import * as deposit from './commands/deposit.js';
import * as withdraw from './commands/withdraw.js';
import * as reads from './commands/reads.js';
import * as edit from './commands/edit.js';
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

// Chat is where everything is answered: a typed message either answers a pending
// prompt (name, amount, handle, …) or is a receipt image upload.
client.on(Events.MessageCreate, (msg) => { void handleMessage(msg).catch((e) => console.error('[msg]', e)); });

async function handleMessage(msg: Message): Promise<void> {
  if (msg.author.bot) return;
  const pending = ses(msg.author.id).pending;
  // Admin uploading a payment-receipt screenshot (may be an image with no text).
  if (pending === 'pay_receipt') return void (await admin.payReceipt(msg));
  const text = msg.content.trim();
  if (pending && text) return void (await routeText(msg, pending, text));
  await onReceiptMessage(msg);
}

async function routeText(msg: Message, pending: string, text: string): Promise<void> {
  switch (pending) {
    case 'name': return void (await start.nameText(msg, text));
    case 'acct': return void (await start.acctText(msg, text));
    case 'clubgg_user': return void (await start.clubggUserText(msg, text));
    case 'edit_clubgg_user': return void (await edit.clubggUserText(msg, text));
    case 'sb_user': return void (await start.sbUserText(msg, text));
    case 'sb_pass': return void (await start.sbPassText(msg, text));
    case 'payout_handle': return void (await start.payoutHandleText(msg, text));
    case 'payout_name': return void (await start.payoutNameText(msg, text));
    case 'edit_payout_name': return void (await edit.payoutNameText(msg, text));
    case 'dep_amount': return void (await deposit.onAmountText(msg, text));
    case 'wd_amount': return void (await withdraw.onAmountText(msg, text));
    case 'wd_handle': return void (await withdraw.onHandleText(msg, text));
    case 'wd_reduce': return void (await withdraw.onReduceText(msg, text));
    case 'cancel_amount': return void (await withdraw.onCancelAmountText(msg, text));
    case 'edit_payout': return void (await edit.payoutHandleText(msg, text));
    case 'edit_acct': return void (await edit.acctText(msg, text));
  }
}

client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // NOTE: we deliberately do NOT update the player's ticket channel here. It's
    // anchored to wherever they ran /start, so every notification lands in that
    // one ticket — not wherever the player happens to click next.
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
    case 'cancelwithdraw': return void (await withdraw.cancelWithdraw(i));
    case 'pending': return void (await reads.pending(i));
    case 'payments': return void (await reads.payments(i));
    case 'guide': return void (await reads.guide(i));
    case 'support': return void (await reads.support(i));
    case 'editplatform': return void (await edit.editPlatform(i));
    case 'editclubs': return void (await edit.editClubs(i));
    case 'editdeposit': return void (await edit.editDeposit(i));
    case 'editwithdraw': return void (await edit.editWithdraw(i));
    case 'ping': return void (await i.reply({ ephemeral: true, content: '🏓 pong' }));
    case 'add': return void (await admin.adjust(i, 1));
    case 'remove': return void (await admin.adjust(i, -1));
    case 'paymentchannel': return void (await admin.setChannel(i, 'payments'));
    case 'adminchannel': return void (await admin.setChannel(i, 'admin'));
    default: await i.reply({ ephemeral: true, content: 'Unknown command.' });
  }
}

/** Route a component/modal interaction by its custom_id ("head:...:args"). */
async function onComponent(i: any): Promise<void> {
  const id: string = i.customId;
  const parts = id.split(':');
  const arg = parts[parts.length - 1]!;         // last segment (an id) for most
  const p2 = parts.slice(2).join(':');           // remainder after head:sub

  // ── onboarding (selects + buttons; text is handled in chat) ──
  if (id === 'ob:platforms') return void (await start.onPlatforms(i));
  if (id === 'ob:sbyes') return void (await start.onSbHas(i, true));
  if (id === 'ob:sbno') return void (await start.onSbHas(i, false));
  if (id.startsWith('ob:clubs:')) return void (await start.onClubs(i, parts[2]!));
  if (id === 'ob:methods') return void (await start.onMethods(i));
  if (id === 'ob:payoutm') return void (await start.onPayoutMethod(i));

  // ── edit ──
  if (id === 'ed:methods') return void (await edit.onMethods(i));
  if (id === 'ed:payoutm') return void (await edit.onPayoutMethod(i));
  if (id === 'ed:clubpf') return void (await edit.onClubPlatform(i));
  if (id.startsWith('ed:clubs:')) return void (await edit.onClubs(i, parts[2]!));
  if (id === 'ed:platforms') return void (await edit.onPlatforms(i));

  // ── deposit ──
  if (id === 'add:pf') return void (await deposit.onPlatform(i));
  if (id === 'add:club') return void (await deposit.onClub(i));
  if (id === 'add:m') return void (await deposit.onMethod(i));

  // ── withdraw ──
  if (id === 'out:pf') return void (await withdraw.onPlatform(i));
  if (id === 'out:club') return void (await withdraw.onClub(i));
  if (id === 'out:m') return void (await withdraw.onMethod(i));
  if (id.startsWith('wd:retract:')) return void (await withdraw.retract(i, arg));
  if (id.startsWith('wc:pick:')) return void (await withdraw.cancelPick(i, arg));
  if (id.startsWith('wc:full:')) return void (await withdraw.cancelFull(i, arg));
  if (id.startsWith('wc:part:')) return void (await withdraw.cancelPart(i, arg));
  if (id.startsWith('wd:reduce:')) return void (await withdraw.reducePrompt(i, arg));

  // ── admin ──
  if (id.startsWith('pl:approve:')) return void (await admin.approve(i, arg));
  if (id.startsWith('fl:verify:')) return void (await admin.verify(i, arg));
  if (id.startsWith('fv:verify:')) return void (await admin.verify(i, arg));
  if (id.startsWith('fv:discard:')) return void (await admin.discard(i, arg));
  if (id.startsWith('lo:claim:')) return void (await admin.loaderClaim(i, arg));
  if (id.startsWith('lo:done:')) return void (await admin.loaderDone(i, parts[2]!, Number(parts[3])));
  if (id.startsWith('lo:fail:')) return void (await admin.loaderFail(i, arg));
  if (id.startsWith('lo:failreason:')) return void (await admin.loaderFailReason(i, arg));
  if (id.startsWith('lo:short:')) return void (await admin.loaderShort(i, arg));
  if (id.startsWith('lo:shortamt:')) return void (await admin.loaderShortAmount(i, arg));
  if (id.startsWith('wd:pay:')) return void (await admin.withdrawPay(i, arg));
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

// Tiny health server. Free hosts (Render, Koyeb) expect a web service to bind a
// port, and an uptime pinger hitting this URL keeps a free instance from sleeping.
// Harmless everywhere else (a VM just ignores it).
function startHealthServer(): void {
  const port = Number(process.env.PORT ?? 8080);
  createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, () => console.log(`[health] listening on ${port}`));
}

async function main(): Promise<void> {
  startHealthServer();
  await registerCommands();
  await client.login(CONFIG.token);
}
void main();
