import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ButtonInteraction, type Message, type Client,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses, clearSes } from '../session.js';
import { money, whole, parseAmount, amountProblem, receiptInstruction, windowLabel } from '../words.js';
import { confirmedPlatforms, depositMethods, methodOption, say, sayChat, sendChannel, selectRow } from '../flows.js';
import { peerpayCheckout } from '../peerpay.js';
import type { PaymentMethod, Fill, Player } from '../core/index.js';

const STRIPE_LINK = () => process.env.STRIPE_PAYMENT_LINK ?? 'https://buy.stripe.com/5kQbJ2gdf2BE9TtbGDc3m07';
// The Stripe payment link caps at $500 — the most we accept for a card/Apple Pay deposit.
const STRIPE_MAX_CENTS = 50000;

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
  // Every method — Stripe/card included — asks the amount up front now, so the
  // player pays that exact amount and the admin gets a one-tap Verify / Discard
  // card (same as Venmo), never a "type the amount" step.
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

  // Route by tier. A 'STRIPE' tier on any method — or the Stripe method's own
  // default (anything that isn't a Staff/PeerPay tier) — diverts to the fixed card
  // link before creating a deposit.
  const [mrow] = await db()<{ code: string; settlement: string }[]>`select code, settlement from payment_methods where id = ${s.addMethod}`;
  const code = mrow?.code ?? '';
  // A P2P method (Venmo/Zelle, Cash App/PayPal when toggled) is NEVER pre-diverted
  // to the card link — it must reach deposit_match, which pays a queued cash-out
  // first and only then falls to its backstop.
  if (mrow?.settlement !== 'p2p') {
    const [tier] = await db()<{ handle: string | null }[]>`
      select club_handle_for(${s.addMethod}::uuid, ${amount}::bigint) as handle`;
    const h = tier?.handle;
    if (h === 'STRIPE' || (code === 'stripe' && h !== 'STAFF' && h !== 'PEERPAY')) {
      // The card/Apple Pay link caps at $500 — don't accept more, or they'd pay $500
      // but we'd have the larger figure they typed on file.
      if (amount > STRIPE_MAX_CENTS) {
        return void (await msg.reply(`The largest card / Apple Pay payment is **${whole(STRIPE_MAX_CENTS)}**. Enter a smaller amount, or use another method.`));
      }
      s.pending = undefined;
      s.stripeAmount = amount;
      return void (await stripeDepositChannel(msg, s.addPlatform, code, amount));
    }
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

  // PeerPay tier: the club fill's handle is the sentinel 'PEERPAY'. Mint a checkout
  // link for this amount. p2p never splits, so a PeerPay deposit is a single fill.
  if (fills.length === 1 && fills[0]!.payout_handle === 'PEERPAY') {
    return void (await sendPeerpayInstruction(msg, fills[0]!, m!));
  }
  // Staff Provide tier: a human sends the handle. Ask staff in the admin channel.
  // Clear any stale addFillId so a screenshot sent WHILE waiting can't attach to an
  // old fill; handleStaffReply sets it once staff hand over the handle.
  if (fills.length === 1 && fills[0]!.payout_handle === 'STAFF') {
    ses(msg.author.id).addFillId = undefined;
    return void (await sendStaffProvideInstruction((c) => sendChannel(msg, c), msg.channelId, msg.client, fills[0]!, m!.name));
  }
  // Stripe tier on a p2p method with no queued cash-out to match: this amount
  // routes to card / Apple Pay. Drop the unmatched p2p fill and hand off to the
  // Stripe link (same destination as a club method's STRIPE tier pre-divert).
  if (fills.length === 1 && fills[0]!.payout_handle === 'STRIPE') {
    await mutate(async (sql) => await sql`select deposit_cancel_latest(${p.id}::uuid)`);
    const st = ses(msg.author.id);
    if (amount > STRIPE_MAX_CENTS) {
      st.pending = undefined;
      return void (await msg.reply(`The largest card / Apple Pay payment is **${whole(STRIPE_MAX_CENTS)}**. Enter a smaller amount, or use another method.`));
    }
    st.stripeAmount = amount;
    return void (await stripeDepositChannel(msg, platformId, m!.code, amount));
  }

  const [tcfg] = await db()<{ match_timeout_seconds: number }[]>`select match_timeout_seconds from config where id`;
  const lines: string[] = [`**💸 Send your ${m!.name} payment now — you have ${windowLabel(tcfg?.match_timeout_seconds ?? 300)}**\n`];
  if (fills.length > 1) lines.push(`Your ${money(amount)} is split across **${fills.length} people**. Pay **each** separately:\n`);
  for (const [idx, f] of fills.entries()) {
    if (fills.length > 1) lines.push(`**── Payment ${idx + 1} of ${fills.length} ──**`);
    lines.push(`Send via **${m!.name}**: **${money(f.gross_to_send, f.currency)}**`);
    if (f.gross_to_send !== f.amount) lines.push(`_(${money(f.amount, f.currency)} + ${money(f.gross_to_send - f.amount, f.currency)} ${m!.name} fee)_`);
    lines.push(`Address: \`${f.payout_handle}\``);
    if (f.payout_name) lines.push(`Name on ${m!.name}: **${f.payout_name}**`);
    lines.push('');
  }
  if (m?.code === 'paypal') lines.push('⚠️ **Make sure to send as Friends & Family** (not Goods & Services).\n');
  lines.push(`Once you've sent it, send ${receiptInstruction(m!.code)} here (upload the image) so we can confirm it.`);
  lines.push('_Got two screenshots? Attach **both to the same message** — a second one sent on its own won\'t be picked up._');
  lines.push('_Changed your mind? `/canceldeposit` before you pay._');
  ses(msg.author.id).addFillId = fills[0]!.id;
  await sendChannel(msg, lines.join('\n'));
}

/** PeerPay deposit: mint a checkout link + show Pay button and a "rail not
 *  available → backup tag" button. The screenshot flow is identical to normal. */
async function sendPeerpayInstruction(msg: Message, f: Fill, m: PaymentMethod): Promise<void> {
  const url = await peerpayCheckout({ amountCents: f.amount, fillId: f.id, rail: m.code });
  ses(msg.author.id).addFillId = f.id;

  if (!url) {
    if (await switchToBackupMsg(msg, f)) return;
    return void (await sendChannel(msg, "We couldn't set up the payment link right now. Please /support and we'll sort it out — nothing was charged."));
  }
  const [pcfg] = await db()<{ match_timeout_seconds: number }[]>`select match_timeout_seconds from config where id`;
  const rowc = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('💳 Pay now').setStyle(ButtonStyle.Link).setURL(url),
    new ButtonBuilder().setCustomId(`pp:backup:${f.id}`).setLabel(`⚠️ ${m.name} not available?`).setStyle(ButtonStyle.Secondary),
  );
  await sendChannel(msg,
    `**💸 Pay ${money(f.amount, f.currency)} — you have ${windowLabel(pcfg?.match_timeout_seconds ?? 300)}**\n\n` +
      `1. Tap **Pay now**.\n` +
      `2. Choose **${m.name}** on the page and send the payment.\n` +
      `3. Come back and **upload a screenshot** of the confirmation here so we can add your money.\n\n` +
      `_${m.name} not showing on the page? Tap the button below for another tag._\n` +
      `_Changed your mind? \`/canceldeposit\` before you pay._`,
    [rowc]);
}

/** Look up a PeerPay fill's backup: a direct tag/link, or the sentinel 'STAFF'. */
async function backupValue(f: Fill): Promise<{ raw: string; methodName: string } | null> {
  const [b] = await db()<{ backup: string | null }[]>`
    select club_backup_for(${f.method_id}::uuid, ${f.amount}::bigint) as backup`;
  const backup = b?.backup?.trim();
  if (!backup) return null;
  const [m] = await db()<{ name: string }[]>`select name from payment_methods where id = ${f.method_id}`;
  return { raw: backup, methodName: m?.name ?? 'the app' };
}

async function switchToBackupMsg(msg: Message, f: Fill): Promise<boolean> {
  const bv = await backupValue(f);
  if (!bv) return false;
  if (bv.raw === 'STAFF') {
    await sendStaffProvideInstruction((c) => sendChannel(msg, c), msg.channelId, msg.client, f, bv.methodName);
    return true;
  }
  await mutate(async (sql) => await sql`update fills set payout_handle = ${bv.raw} where id = ${f.id} and status = 'locked'`);
  ses(msg.author.id).addFillId = f.id;
  await sendChannel(msg,
    `No problem — pay **${money(f.amount, f.currency)}** to \`${bv.raw}\` on **${bv.methodName}** instead, ` +
      `then upload a screenshot of the confirmation here.`);
  return true;
}

/** "Payment method not available?" button on a PeerPay deposit → reveal backup. */
export async function peerpayBackup(i: ButtonInteraction, fillId: string): Promise<void> {
  const [f] = await db()<Fill[]>`select * from fills where id = ${fillId}`;
  if (!f || f.status !== 'locked') {
    return void (await i.reply({ ephemeral: true, content: 'That deposit is no longer waiting — `/deposit` again.' }));
  }
  const bv = await backupValue(f);
  try { await i.update({ components: [] }); } catch { /* buttons already gone */ }
  if (!bv) {
    return void (await i.followUp({ ephemeral: false, content: "There's no backup tag set for this one. Please /support and we'll help you pay." }));
  }
  if (bv.raw === 'STAFF') {
    await sendStaffProvideInstruction((c) => i.followUp({ ephemeral: false, content: c }).then(() => {}), i.channelId!, i.client, f, bv.methodName);
    return;
  }
  await mutate(async (sql) => await sql`update fills set payout_handle = ${bv.raw} where id = ${f.id} and status = 'locked'`);
  ses(i.user.id).addFillId = f.id;
  await i.followUp({
    ephemeral: false,
    content: `No problem — pay **${money(f.amount, f.currency)}** to \`${bv.raw}\` on **${bv.methodName}** instead, ` +
      `then upload a screenshot of the confirmation here.`,
  });
}

/** Staff Provide: tell the player to hold on, post a request in the admin channel,
 *  and record it so a staff member's REPLY there routes the handle back. `send`
 *  posts to the player; `channelId`/`client` locate the channels. */
async function sendStaffProvideInstruction(
  send: (c: string) => Promise<unknown>, channelId: string, client: Client, f: Fill, methodName: string,
): Promise<void> {
  await send(`⏳ **Hold on a moment** — a staff member is getting you a payment handle for **${money(f.amount, f.currency)}**. You'll get it right here shortly.\n_Changed your mind? \`/canceldeposit\` anytime before you pay._`);
  const [cfg] = await db()<{ discord_admin_channel_id: string | null }[]>`select discord_admin_channel_id from config where id`;
  const adminChan = cfg?.discord_admin_channel_id;
  const ach = adminChan ? await client.channels.fetch(adminChan).catch(() => null) : null;
  if (!adminChan || !ach || !ach.isTextBased() || !('send' in ach)) {
    await send("We couldn't reach a staff member right now. Please /support and we'll help you pay.");
    return;
  }
  // Identify the depositor by their platform ACCOUNT, same as the verify card:
  // ClubGG username (not the numeric ID) or Sportsbook username, plus the club.
  const [pl] = await db()<{ from_name: string | null; platform: string | null; club: string | null }[]>`
    select coalesce(case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end, dp.display_name) as from_name,
           pf.name as platform, c.name as club
      from deposit_requests d
      join players dp on dp.id = d.player_id
      left join platforms pf on pf.id = d.platform_id
      left join player_platforms pp on pp.player_id = d.player_id and pp.platform_id = d.platform_id
      left join clubs c on c.id = pp.club_id
     where d.id = ${f.deposit_id}`;
  const who = pl?.from_name ?? 'A player';
  const tag = pl?.platform ? ` [${pl.platform}${pl.club ? ' · ' + pl.club : ''}]` : '';
  const playerName = `${who}${tag}`;
  const sent = await ach.send(
    `🙋 **Payment handle needed**\n**${who}**${tag} wants to deposit **${money(f.amount, f.currency)}** via **${methodName}**.\n` +
      `↩️ **Reply to this message** with the tag or link to send them.`);
  await mutate(async (sql) => await sql`
    insert into staff_handle_req (fill_id, platform, admin_chat_id, admin_message_id, player_chat_id, amount, currency, method_name, player_name)
    values (${f.id}::uuid, 'discord', ${adminChan}, ${sent.id}, ${channelId}, ${f.amount}::bigint, ${f.currency}, ${methodName}, ${playerName})
    on conflict (platform, admin_chat_id, admin_message_id) do nothing`);
}

/** A staff member replied in the admin channel to a "handle needed" request.
 *  Repoint the fill, relay the tag/link to the player's channel, and mark them
 *  awaiting a receipt. Returns true if this message was a staff reply we handled. */
export async function handleStaffReply(msg: Message): Promise<boolean> {
  const refId = msg.reference?.messageId;
  if (!refId) return false;
  const [req] = await db()<{
    id: string; fill_id: string; player_chat_id: string; amount: string; currency: string; method_name: string | null;
  }[]>`
    select id, fill_id, player_chat_id, amount, currency, method_name
      from staff_handle_req
     where platform = 'discord' and admin_chat_id = ${msg.channelId}
       and admin_message_id = ${refId} and status = 'pending'`;
  if (!req) return false;

  const handle = msg.content.trim();
  if (!handle) { await msg.reply('Reply with the tag or link (text) to send the player.'); return true; }

  const [f] = await db()<{ status: string }[]>`select status from fills where id = ${req.fill_id}`;
  if (!f || f.status !== 'locked') {
    await mutate(async (sql) => await sql`update staff_handle_req set status = 'cancelled' where id = ${req.id}`);
    await msg.reply('That deposit is no longer waiting (cancelled or already handled).');
    return true;
  }
  await mutate(async (sql) => {
    await sql`update fills set payout_handle = ${handle} where id = ${req.fill_id} and status = 'locked'`;
    await sql`update staff_handle_req set status = 'provided', provided_handle = ${handle} where id = ${req.id}`;
  });

  // Find the player (to mark them awaiting a receipt) and relay to their channel.
  const [pl] = await db()<{ discord_id: string }[]>`
    select dp.discord_id from fills f
      join deposit_requests d on d.id = f.deposit_id
      join discord_players dp on dp.player_id = d.player_id
     where f.id = ${req.fill_id}`;
  if (pl) ses(pl.discord_id).addFillId = req.fill_id;

  const amt = money(Number(req.amount), req.currency);
  const isLink = /^https?:\/\//i.test(handle);
  const content = isLink
    ? `✅ **Here's your payment link for ${amt}**\n${handle}\nPay it, then upload a screenshot of the confirmation here.`
    : `✅ **Pay ${amt} to:**\n\`${handle}\`\nvia **${req.method_name ?? 'the app'}**. Upload a screenshot of the confirmation here once you've paid.`;
  const ch = await msg.client.channels.fetch(req.player_chat_id).catch(() => null);
  if (ch && ch.isTextBased() && 'send' in ch) await ch.send(content);

  await msg.reply("✅ Sent to the player. They'll pay and send a screenshot to verify.");
  return true;
}

async function stripeDeposit(i: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction, platformId: string, methodCode = 'stripe', amount?: number): Promise<void> {
  const s = ses(i.user.id); s.stripePlatform = platformId; s.stripeAmount = amount;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('💳 Pay now').setStyle(ButtonStyle.Link).setURL(STRIPE_LINK()));
  const content = stripeText(methodCode, amount);
  if (i.replied || i.deferred) await i.followUp({ ephemeral: false, content, components: [row] });
  else await i.reply({ ephemeral: false, content, components: [row] });
}

async function stripeDepositChannel(msg: Message, platformId: string, methodCode = 'stripe', amount?: number): Promise<void> {
  const s = ses(msg.author.id); s.stripePlatform = platformId; s.stripeAmount = amount;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('💳 Pay now').setStyle(ButtonStyle.Link).setURL(STRIPE_LINK()));
  await sendChannel(msg, stripeText(methodCode, amount), [row]);
}

// Same secure link for both; a Cash App deposit routed here pays with Cash App Pay
// on the page, a card/Apple Pay deposit doesn't — so tailor the wording. The amount
// is taken up front, so we tell them the exact figure to pay.
const stripeText = (methodCode = 'stripe', amount?: number) => {
  const isCashapp = methodCode === 'cashapp';
  const title = isCashapp ? '💵 **Pay with Cash App Pay**' : '💳 **Pay by Card or Apple Pay**';
  const amt = amount ? `**${money(amount)}**` : 'the amount';
  const step1 = isCashapp
    ? `Tap below, choose **Cash App Pay** on the page, and pay ${amt}.`
    : `Tap below and pay ${amt} on the page.`;
  return `${title}\n\n${step1}\n` +
    `Then come back here and **upload a screenshot** of the "Thanks for your payment" screen.\n` +
    `_Changed your mind? Just don't pay — nothing is charged until you do._`;
};

/** /canceldeposit — drop the latest un-paid deposit. */
export async function cancelDeposit(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  const d = await mutate(async (sql) => sql<{ id: string }[]>`select id from deposit_cancel_latest(${p.id}::uuid)`);
  clearSes(i.user.id);
  if (!d[0]?.id) {
    // Nothing un-paid to cancel — but if a receipt is already in, say THAT clearly.
    // It can't be cancelled (the payment may have gone through); an admin verifies it.
    const [chk] = await db()<{ amount: number; currency: string }[]>`
      select amount, currency from deposit_requests
       where player_id = ${p.id} and status = 'awaiting_confirmation' order by created_at desc limit 1`;
    if (chk) {
      return void (await say(i, `⏳ Your **${money(chk.amount, chk.currency)}** payment is being checked by our team — it can't be cancelled now. You'll get a message here the moment it's confirmed. \`/support\` if you need help.`));
    }
    return void (await say(i, "You don't have a deposit to cancel. Start one anytime with `/deposit`."));
  }
  await say(i, '✅ Your deposit was cancelled. If you already sent the money, use /support and we\'ll sort it out.');
}
