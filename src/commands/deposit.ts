import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ButtonInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses, clearSes } from '../session.js';
import { money, whole, parseAmount, amountProblem, receiptInstruction } from '../words.js';
import { confirmedPlatforms, depositMethods, methodOption, say, sayChat, sendChannel, selectRow } from '../flows.js';
import type { PaymentMethod, Fill, Player } from '../core/index.js';

const STRIPE_LINK = () => process.env.STRIPE_PAYMENT_LINK ?? 'https://buy.stripe.com/5kQbJ2gdf2BE9TtbGDc3m07';

/** /deposit — add money. platform → club → method → amount → pay → receipt. */
export async function deposit(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to set up first.'));
  if (p.status !== 'active') return void (await say(i, "You're almost ready — we just need to confirm your account. You'll get a message here the moment that's done."));

  const platforms = await confirmedPlatforms(p.id);
  if (platforms.length === 0) return void (await say(i, "You don't have a confirmed account on any platform yet. `/start` to set one up."));
  if (platforms.length === 1) return void (await afterPlatform(i, platforms[0]!.id));
  await say(i, 'Where do you want to add money?', [selectRow('add:pf', 'Choose platform', platforms.map((pf) => ({ label: pf.name, value: pf.id })))]);
}

export async function onPlatform(i: StringSelectMenuInteraction): Promise<void> {
  await i.update({ components: [] });
  await afterPlatform(i, i.values[0]!);
}

async function afterPlatform(i: ChatInputCommandInteraction | StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  ses(i.user.id).addPlatform = platformId;
  const clubs = await db()<{ id: string; name: string }[]>`
    select c.id, c.name from clubs c join player_clubs pc on pc.club_id = c.id
     where pc.player_id = ${p.id} and c.platform_id = ${platformId} and c.enabled order by c.name`;
  if (clubs.length > 1) return void (await say(i, 'Which club is this going to?', [selectRow('add:club', 'Choose club', clubs.map((c) => ({ label: c.name, value: c.id })))]));
  if (clubs.length === 1) await mutate(async (sql) => await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${clubs[0]!.id}::uuid)`);
  await askMethod(i, platformId);
}

export async function onClub(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const platformId = ses(i.user.id).addPlatform!;
  try { await mutate(async (sql) => await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${i.values[0]!}::uuid)`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.update({ components: [] });
  await askMethod(i, platformId);
}

async function askMethod(i: ChatInputCommandInteraction | StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const methods = await depositMethods(p.id);
  if (methods.length === 0) return void (await say(i, 'No payment methods are available right now. Please contact us.'));
  if (methods.length === 1) return void (await proceed(i, platformId, methods[0]!));
  await say(i, 'How do you want to pay?', [selectRow('add:m', 'Choose method', methods.map(methodOption))]);
}

export async function onMethod(i: StringSelectMenuInteraction): Promise<void> {
  const platformId = ses(i.user.id).addPlatform!;
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${i.values[0]!}`;
  if (!m) return void (await i.update({ content: 'That method is gone — /deposit again.', components: [] }));
  await i.update({ components: [] });
  await proceed(i, platformId, m);
}

async function proceed(i: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction, platformId: string, m: PaymentMethod): Promise<void> {
  const s = ses(i.user.id);
  s.addPlatform = platformId;
  s.addMethod = m.id;
  if (m.code === 'stripe') return void (await stripeDeposit(i, platformId));
  // Ask the amount IN CHAT (no popup form). The player just types a number; the
  // message handler picks it up via session.pending.
  s.pending = 'dep_amount';
  const [pf] = await db()<{ name: string }[]>`select name from platforms where id = ${platformId}`;
  await sayChat(i, `How much do you want to add to **${pf?.name}** with **${m.name}**? Just **type the number** here — like \`20\` or \`50\`.`);
}

/** Player typed a deposit amount in chat (session.pending === 'dep_amount'). */
export async function onAmountText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id);
  const s = ses(msg.author.id);
  if (!p || !s.addPlatform || !s.addMethod) return;
  const amount = parseAmount(text);
  const cfg = (await db()<{ min_amount: number; max_amount: number; amount_step: number }[]>`select min_amount, max_amount, amount_step from config where id`)[0]!;
  if (amount === null) return void (await msg.reply('That doesn\'t look like an amount. Try `20` or `50`.'));
  const problem = amountProblem(amount, { min: cfg.min_amount, max: cfg.max_amount, step: cfg.amount_step });
  if (problem) return void (await msg.reply(problem));

  const [mm] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${s.addMethod}`;
  if (mm?.code === 'cashapp' && amount < 25000) {
    s.pending = undefined;
    await msg.reply('💵 For Cash App **under $250**, pay through our secure link and choose **Cash App Pay** on the page.');
    return void (await stripeDepositChannel(msg, s.addPlatform));
  }
  s.pending = undefined;
  await runMatch(msg, p, s.addPlatform, amount, s.addMethod);
}

async function runMatch(msg: Message, p: Player, platformId: string, amount: number, methodId: string): Promise<void> {
  let fills: Fill[];
  try {
    const d = await mutate(async (sql) => await sql<{ id: string }[]>`select id from deposit_create(${p.id}::uuid, ${platformId}::uuid, ${methodId}::uuid, ${amount}::bigint)`);
    fills = await db()<Fill[]>`select * from fills where deposit_id = ${d[0]!.id} order by seq`;
  } catch (e) {
    ses(msg.author.id).pending = undefined;
    if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`));
    console.error('deposit_create failed:', e);
    return void (await msg.reply('Something went wrong. Nothing was charged. Try again in a moment.'));
  }
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  const lines: string[] = [`**💸 Send your ${m!.name} payment now — you have 5 minutes**\n`];
  if (fills.length > 1) lines.push(`Your ${money(amount)} is split across **${fills.length} people**. Pay **each** separately:\n`);
  for (const [idx, f] of fills.entries()) {
    if (fills.length > 1) lines.push(`**── Payment ${idx + 1} of ${fills.length} ──**`);
    lines.push(`Send via **${m!.name}**: **${money(f.gross_to_send, f.currency)}**`);
    if (f.gross_to_send !== f.amount) lines.push(`_(${money(f.amount, f.currency)} + ${money(f.gross_to_send - f.amount, f.currency)} ${m!.name} fee)_`);
    lines.push(`Address: \`${f.payout_handle}\``);
    lines.push('');
  }
  if (m?.code === 'paypal') lines.push('⚠️ **Make sure to send as Friends & Family** (not Goods & Services).\n');
  lines.push(`Once you've sent it, **send ${receiptInstruction(m!.code)}** here (upload the image) so we can confirm it.`);
  lines.push('_Changed your mind? `/canceldeposit` before you pay._');
  ses(msg.author.id).addFillId = fills[0]!.id;
  await sendChannel(msg, lines.join('\n'));
}

async function stripeDeposit(i: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction, platformId: string): Promise<void> {
  const cfg = (await db()<{ min_amount: number; max_amount: number }[]>`select min_amount, max_amount from config where id`)[0]!;
  ses(i.user.id).stripePlatform = platformId;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('💳 Pay now').setStyle(ButtonStyle.Link).setURL(STRIPE_LINK()));
  const content = stripeText(cfg);
  if (i.replied || i.deferred) await i.followUp({ ephemeral: false, content, components: [row] });
  else await i.reply({ ephemeral: false, content, components: [row] });
}

async function stripeDepositChannel(msg: Message, platformId: string): Promise<void> {
  const cfg = (await db()<{ min_amount: number; max_amount: number }[]>`select min_amount, max_amount from config where id`)[0]!;
  ses(msg.author.id).stripePlatform = platformId;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('💳 Pay now').setStyle(ButtonStyle.Link).setURL(STRIPE_LINK()));
  await sendChannel(msg, stripeText(cfg), [row]);
}

const stripeText = (cfg: { min_amount: number; max_amount: number }) =>
  `💳 **Pay by Card, Apple Pay, or Cash App Pay**\n\nTap below, enter the amount you want to add (between ${whole(cfg.min_amount)} and ${whole(cfg.max_amount)}) and pay. ` +
  `Then come back here and **upload a screenshot** of the "Thanks for your payment" screen.`;

/** /canceldeposit — drop the latest un-paid deposit. */
export async function cancelDeposit(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  const d = await mutate(async (sql) => sql<{ id: string }[]>`select id from deposit_cancel_latest(${p.id}::uuid)`);
  clearSes(i.user.id);
  if (!d[0]?.id) return void (await say(i, "You don't have a deposit to cancel. (If you already sent a receipt, it's being checked — /support if you need help.)"));
  await say(i, '✅ Your deposit was cancelled. If you already sent the money, use /support and we\'ll sort it out.');
}
