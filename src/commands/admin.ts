import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle,
  type ButtonInteraction, type ModalSubmitInteraction, type ChatInputCommandInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { uploadReceipt, storageConfigured, platformTotals } from '../core/index.js';
import { currentAdmin } from '../identity.js';
import { ses } from '../session.js';
import { money } from '../words.js';
import { editDiscordCard } from '../notifier.js';

async function admin(i: ButtonInteraction | ModalSubmitInteraction): Promise<{ id: string } | null> {
  const a = await currentAdmin(i.user.id);
  if (!a) { await i.reply({ ephemeral: true, content: 'Admins only.' }); return null; }
  return a;
}
async function fail(i: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction, e: unknown): Promise<void> {
  if (isUserError(e)) { await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` }); return; }
  throw e;
}
async function fail2(msg: Message, e: unknown): Promise<void> {
  if (isUserError(e)) { await msg.reply(`❌ ${userMessage(e)}`); return; }
  throw e;
}
const done = (i: ButtonInteraction, text: string) => i.update({ content: text, components: [] });

/**
 * The identity block on EVERY loader card — the platform ACCOUNT name (ClubGG
 * username / Sportsbook username, never a bare numeric id), a [platform] tag, and
 * the club. Matches the fresh loader.work card in notifier.ts, so a claimed /
 * advanced card never drops back to just the display name. Callers select these
 * columns with loaderIdSelect() + loaderIdJoins().
 */
export type LoaderId = { account: string; platform: string | null; platform_uid: string; club: string | null };
export function loaderIdentity(o: LoaderId): string {
  // Match the verify card: account, then [platform · club] together in the bracket.
  const tag = o.platform ? ` [${o.platform}${o.club ? ` · ${o.club}` : ''}]` : '';
  return `Player: **${o.account}**${tag} \`${o.platform_uid}\``;
}
export function loaderIdSelect() {
  return db()`coalesce(case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end, o.player_name) as account,
              pf.name as platform, cl.name as club, o.platform_uid`;
}
export function loaderIdJoins() {
  return db()`left join platforms pf on pf.id = o.platform_id
              left join player_platforms pp on pp.player_id = o.player_id and pp.platform_id = o.platform_id
              left join clubs cl on cl.id = o.club_id`;
}

/** Approve a player — links every platform they've claimed. */
export async function approve(i: ButtonInteraction, ppId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const [pp] = await db()<{ player_id: string }[]>`select player_id from player_platforms where id = ${ppId}`;
  if (!pp) return void (await i.reply({ ephemeral: true, content: 'That request no longer exists.' }));
  try { await mutate(async (sql) => await sql`select player_link_all(${pp.player_id}::uuid, ${a.id}::uuid)`); } catch (e) { return void (await fail(i, e)); }
  await done(i, `✅ **Approved** by ${i.user.username} — the player has been told.`);
}

/**
 * ✅ Verify — one message: verify & release (player is told the money's on its
 * way), then CLAIM the loader task it created (locked to this admin) and turn the
 * same card into Done/Failed. 🗑 Discard silently rejects (no credit).
 */
export async function verify(i: ButtonInteraction, fillId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try {
    await mutate(async (sql) => await sql`select fill_admin_verify(${fillId}::uuid, ${a.id}::uuid, 'verified via discord')`);
  } catch (e) {
    if (!isUserError(e)) return void (await fail(i, e));
    // Already released/handled — verified in the panel, by another admin, or this
    // card went stale. Don't dead-end: refresh it to the step it's actually at.
  }
  await advanceLoaderCard(i, a.id, fillId);
}

/** Turn the verify card into the loader "ADD" step (or a done/closed summary).
 *  Safe whether we just released the fill or found it already released. */
async function advanceLoaderCard(i: ButtonInteraction, adminId: string, fillId: string): Promise<void> {
  const [o] = await db()<{ id: string; delta: number; currency: string; account: string; platform: string | null; platform_uid: string; club: string | null; status: string }[]>`
    select o.id, o.delta, o.currency, o.status, ${loaderIdSelect()}
      from loader_orders o ${loaderIdJoins()}
     where o.ref_type='fill' and o.ref_id=${fillId} order by o.created_at desc limit 1`;
  if (!o) return void (await i.update({ content: `✅ **Verified & released** · by ${i.user.username}`, components: [], embeds: [] }));
  if (o.status === 'done') return void (await i.update({ content: `✅ **Verified & loaded** — ${money(o.delta, o.currency)} added to their table.`, components: [], embeds: [] }));
  if (o.status === 'cancelled' || o.status === 'failed') return void (await i.update({ content: `✅ **Verified** — loading was ${o.status}.`, components: [], embeds: [] }));

  try { await mutate(async (sql) => await sql`select loader_order_claim(${o.id}::uuid, ${adminId}::uuid)`); } catch { /* raced */ }
  await db()`update notifications set status='skipped' where kind='loader.work' and ref_type='loader_order' and ref_id=${o.id} and status='pending'`;
  // If the standalone loader card was ALREADY delivered before this verify, it's a
  // duplicate now — neutralise it so nobody taps a dead "Add" button on it.
  await editDiscordCard(i.client, 'loader_order', o.id, '↪️ **Being handled on the payment card above.**').catch(() => {});
  const r = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lo:done:${o.id}:${o.delta}`).setLabel(`✅ Done — added ${money(o.delta, o.currency)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lo:fail:${o.id}`).setLabel('❌ Failed').setStyle(ButtonStyle.Danger),
  );
  await i.update({ content: `🎰 **ADD ${money(o.delta, o.currency)}** to their table — ${loaderIdentity(o)}\n_Claimed by ${i.user.username}._ Add it, then:`, components: [r] });
}

/** 🗑 Discard — payment didn't land: silent reject, no credit, slice returns. */
export async function discard(i: ButtonInteraction, fillId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select fill_admin_discard(${fillId}::uuid, ${a.id}::uuid)`); } catch (e) { return void (await fail(i, e)); }
  await i.update({ content: `🗑 **Payment discarded** · by ${i.user.username}`, components: [], embeds: [] });
}

/** Claim a loader job → swap to do/fail actions. */
export async function loaderClaim(i: ButtonInteraction, orderId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try {
    await mutate(async (sql) => await sql`select loader_order_claim(${orderId}::uuid, ${a.id}::uuid)`);
  } catch (e) {
    if (!isUserError(e)) return void (await fail(i, e));
    // Already claimed/done — don't dead-end; refresh the card to its real state.
  }
  await showLoaderStep(i, orderId);
}

/** Render a loader order's current step: the Done/Failed action (with who claimed
 *  it) while pending/claimed, or a done/closed summary. Self-heals a stale card. */
async function showLoaderStep(i: ButtonInteraction, orderId: string): Promise<void> {
  const [o] = await db()<{ delta: number; currency: string; account: string; platform: string | null; platform_uid: string; club: string | null; status: string; claimer: string | null }[]>`
    select o.delta, o.currency, o.status, a.display_name as claimer, ${loaderIdSelect()}
      from loader_orders o
      left join admins a on a.id = o.claimed_by
      ${loaderIdJoins()}
     where o.id = ${orderId}`;
  if (!o) return void (await i.update({ content: '↩️ That task no longer exists.', components: [], embeds: [] }));
  const load = o.delta > 0;
  if (o.status === 'done') return void (await i.update({ content: `✅ **Done** — ${money(Math.abs(o.delta), o.currency)} ${load ? 'added' : 'taken off'}.`, components: [], embeds: [] }));
  if (o.status === 'cancelled' || o.status === 'failed') return void (await i.update({ content: `⚠️ **${o.status[0]!.toUpperCase() + o.status.slice(1)}** — ${money(Math.abs(o.delta), o.currency)}.`, components: [], embeds: [] }));

  const r = new ActionRowBuilder<ButtonBuilder>();
  r.addComponents(new ButtonBuilder().setCustomId(`lo:done:${orderId}:${o.delta}`).setLabel(load ? `✅ Done — added ${money(o.delta, o.currency)}` : `✅ All ${money(-o.delta, o.currency)}`).setStyle(ButtonStyle.Success));
  if (!load) r.addComponents(new ButtonBuilder().setCustomId(`lo:short:${orderId}`).setLabel('✏️ Different amount').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`lo:done:${orderId}:0`).setLabel('❌ Nothing there').setStyle(ButtonStyle.Secondary));
  else r.addComponents(new ButtonBuilder().setCustomId(`lo:fail:${orderId}`).setLabel('❌ Failed').setStyle(ButtonStyle.Danger));
  const by = o.claimer ? `_Claimed by ${o.claimer}._` : '';
  await i.update({ content: `🎰 **${load ? 'ADD' : 'TAKE OFF'} ${money(Math.abs(o.delta), o.currency)}** — ${loaderIdentity(o)}\n${by} Tap the amount you actually ${load ? 'added' : 'took off'}:`, components: [r] });
}

export async function loaderDone(i: ButtonInteraction, orderId: string, delta: number): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select loader_order_complete(${orderId}::uuid, ${a.id}::uuid, ${delta}::bigint, 'via discord')`); }
  catch (e) {
    if (!isUserError(e)) return void (await fail(i, e));
    // Already done/claimed elsewhere (a stale duplicate card). Don't leave a live
    // button that dead-ends — refresh THIS card to the job's real state.
    return void (await showLoaderStep(i, orderId));
  }
  await done(i, `✅ **Transaction completed by ${i.user.username}**${delta === 0 ? ' — nothing was available' : ' — ' + money(Math.abs(delta))}`);
}

/** "Failed" → ask WHY in a modal, so the player can be told the reason. */
export async function loaderFail(i: ButtonInteraction, orderId: string): Promise<void> {
  if (!(await admin(i))) return;
  await i.showModal(new ModalBuilder().setCustomId(`lo:failreason:${orderId}`).setTitle('Why did it fail?')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel('Reason (the player is told this)').setStyle(TextInputStyle.Paragraph).setRequired(true))));
}
export async function loaderFailReason(i: ModalSubmitInteraction, orderId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const reason = i.fields.getTextInputValue('reason').trim();
  try { await mutate(async (sql) => await sql`select loader_order_fail(${orderId}::uuid, ${a.id}::uuid, ${reason})`); } catch (e) { return void (await fail(i, e)); }
  await i.reply({ ephemeral: false, content: `❌ **Failed** · by ${i.user.username} — the player was told the reason.` });
}

export async function loaderShort(i: ButtonInteraction, orderId: string): Promise<void> {
  if (!(await admin(i))) return;
  await i.showModal(amountModal(`lo:shortamt:${orderId}`, 'Amount you took off'));
}
export async function loaderShortAmount(i: ModalSubmitInteraction, orderId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const cents = parseCents(i.fields.getTextInputValue('amount'));
  if (cents === null) return void (await i.reply({ ephemeral: true, content: 'Send just the number, e.g. `30`.' }));
  try { await mutate(async (sql) => await sql`select loader_order_complete(${orderId}::uuid, ${a.id}::uuid, ${-cents}::bigint, 'via discord')`); } catch (e) { return void (await fail(i, e)); }
  await i.reply({ ephemeral: false, content: `✅ Recorded ${money(cents)} · by ${i.user.username}` });
}

/** "I paid it" on a cash-out → ask for a screenshot (posted in the channel). A
 *  Discord modal can't take a file upload, so we collect the next message from
 *  this admin instead (image → receipt for the player; text → reference). */
export async function withdrawPay(i: ButtonInteraction, withdrawId: string): Promise<void> {
  if (!(await admin(i))) return;
  const s = ses(i.user.id);
  s.pending = 'pay_receipt';
  s.payWithdrawId = withdrawId;
  // Drop the "I paid it" button so it can't be tapped twice; the card is rewritten
  // to its finished state once the payment is recorded.
  await i.update({ content: `${i.message.content}\n\n⏳ _Waiting for ${i.user.username} to post the receipt…_`, components: [] });
  await i.followUp({ ephemeral: true, content: '📸 Post a **screenshot** of the payment you sent here — the player gets it as their receipt.\n\n_No screenshot? Just type the transaction ID instead._' });
}

/** The admin's next message after "I paid it": an image (receipt, forwarded to
 *  the player) or text (a plain reference). Rewrites the card to one finished
 *  message and clears the admin's message so nothing stale is left. */
export async function payReceipt(msg: Message): Promise<void> {
  const s = ses(msg.author.id);
  const withdrawId = s.payWithdrawId;
  const a = await currentAdmin(msg.author.id);
  const img = msg.attachments.find((at) => (at.contentType ?? '').startsWith('image/')) ?? msg.attachments.first();
  const text = msg.content.trim();
  if (!img && !text) return void (await msg.reply('Post a screenshot of the payment, or type the transaction ID.'));
  s.pending = undefined;
  s.payWithdrawId = undefined;
  if (!withdrawId || !a) return;

  // A screenshot → copy it into permanent storage (Discord CDN links expire) so the
  // receipt stays viewable + clickable in the player's history. Falls back to the CDN url.
  let receiptUrl: string | null = null;
  if (img) {
    receiptUrl = img.url;
    if (storageConfigured()) {
      try {
        const res = await fetch(img.url);
        const stored = await uploadReceipt(Buffer.from(await res.arrayBuffer()), img.contentType ?? 'image/jpeg', 'fill', withdrawId);
        receiptUrl = stored.url;
      } catch { /* fall back to the CDN url */ }
    }
  }

  let paid: { amount: number; currency: string } | undefined;
  try {
    [paid] = await mutate(async (sql) => sql<{ amount: number; currency: string }[]>`
      select amount, currency from withdraw_club_payout(${withdrawId}::uuid, ${a.id}::uuid, null,
                                          ${img ? null : text}, 'paid via discord', ${receiptUrl})`);
  } catch (e) { return void (await fail2(msg, e)); }

  const [wr] = await db()<{ name: string | null }[]>`
    select pl.display_name as name from withdraw_requests w
      join players pl on pl.id = w.player_id where w.id = ${withdrawId}`;
  const ref = img ? '' : ` (ref \`${text}\`)`;
  const doneText = `✅ **Cash-out paid** — ${money(paid!.amount, paid!.currency)} to **${wr?.name ?? 'the player'}** · by ${msg.author.username}${ref}`;
  const edited = await editDiscordCard(msg.client, 'withdraw_request', withdrawId, doneText, [], 'withdraw.needs_payout').catch(() => false);
  if (edited) await msg.delete().catch(() => { /* needs Manage Messages */ });
  else await msg.reply(doneText).catch(() => { /* leave one confirmation */ });
}

/** Sportsbook account created. */
export async function sbMade(i: ButtonInteraction, playerId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const [sb] = await db()<{ id: string }[]>`select id from platforms where code = 'sportsbook'`;
  try { await mutate(async (sql) => await sql`select sb_mark_created(${playerId}::uuid, ${sb!.id}::uuid, ${a.id}::uuid, null)`); } catch (e) { return void (await fail(i, e)); }
  await done(i, `✅ **Account created** · by ${i.user.username} — the player was resumed.`);
}

/** Stripe: credit the matched amount, or ask for it. */
export async function stripeOk(i: ButtonInteraction, claimId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select stripe_claim_credit(${claimId}::uuid, ${a.id}::uuid, null)`); } catch (e) { return void (await fail(i, e)); }
  await i.update({ content: `✅ **Credited** · by ${i.user.username}`, components: [], embeds: [] });
}
export async function stripeCredit(i: ButtonInteraction, claimId: string): Promise<void> {
  if (!(await admin(i))) return;
  await i.showModal(amountModal(`st:creditamt:${claimId}`, 'Amount to credit'));
}
/** 🗑 Discard a Stripe receipt — no credit, symmetric with a P2P/club Discard. */
export async function stripeDiscard(i: ButtonInteraction, claimId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select stripe_claim_discard(${claimId}::uuid, ${a.id}::uuid)`); } catch (e) { return void (await fail(i, e)); }
  await i.update({ content: `🗑 **Discarded** · by ${i.user.username}`, components: [], embeds: [] });
}
export async function stripeCreditAmount(i: ModalSubmitInteraction, claimId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const cents = parseCents(i.fields.getTextInputValue('amount'));
  if (cents === null) return void (await i.reply({ ephemeral: true, content: 'Send just the number, e.g. `50`.' }));
  try { await mutate(async (sql) => await sql`select stripe_claim_credit(${claimId}::uuid, ${a.id}::uuid, ${cents}::bigint)`); } catch (e) { return void (await fail(i, e)); }
  await i.reply({ ephemeral: false, content: `✅ Credited ${money(cents)} · by ${i.user.username}` });
}

/**
 * ADMIN CASH-OUT CONTROLS — run inside the player's ticket channel (the player is
 * found by discord_players.ticket_channel_id).
 *
 *   /pausewithdraw   take their cash-out out of the queue so nobody else pays it
 *   /resumewithdraw  put it back at its original place in the queue
 *   /adjust +50      grow what they're owed by $50
 *   /adjust -50 receipt:<img>  record a $50 payment YOU made — reduces the cash-out,
 *                    saves the receipt to their history, completes it if it hits $0.
 *                    Works even while paused.
 */
async function ticketTarget(i: ChatInputCommandInteraction): Promise<{ id: string; name: string; withdrawId: string } | null> {
  const [pl] = await db()<{ id: string; display_name: string | null }[]>`
    select p.id, p.display_name from players p
      join discord_players dp on dp.player_id = p.id
     where dp.ticket_channel_id = ${i.channelId}`;
  if (!pl) { await i.reply({ ephemeral: true, content: "No player is linked to this channel, so there's nothing to do here." }); return null; }
  const [w] = await db()<{ id: string }[]>`
    select id from withdraw_requests
     where player_id = ${pl.id} and status in ('queued', 'partially_filled', 'filled')
     order by created_at desc limit 1`;
  if (!w) { await i.reply({ ephemeral: true, content: `${pl.display_name ?? 'This player'} has no cash-out in progress.` }); return null; }
  return { id: pl.id, name: pl.display_name ?? 'this player', withdrawId: w.id };
}

/** /totals — money in / out per platform (ClubGG, Sportsbook, …), all-time. */
export async function totalsCmd(i: ChatInputCommandInteraction): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const rows = await platformTotals();
  if (rows.length === 0) return void (await i.reply({ ephemeral: true, content: 'No platforms set up yet.' }));
  let din = 0, dout = 0;
  const lines = rows.map((t) => {
    din += Number(t.deposited); dout += Number(t.withdrawn);
    const net = Number(t.deposited) - Number(t.withdrawn);
    return `**${t.name}**\n⬇︎ Deposited in: ${money(Number(t.deposited))} · ⬆︎ Cashed out: ${money(Number(t.withdrawn))} · ⚖︎ Net: ${money(net)}`;
  });
  await i.reply({
    ephemeral: true,
    content: `📊 **Totals by platform** (all-time)\n\n${lines.join('\n\n')}\n\n————\n**All platforms** — in ${money(din)} · out ${money(dout)} · net ${money(din - dout)}`,
  });
}

export async function pauseWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const t = await ticketTarget(i); if (!t) return;
  try { await mutate(async (sql) => await sql`select withdraw_pause(${t.withdrawId}::uuid, ${a.id}::uuid)`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.reply({ ephemeral: false, content: `⏸ Paused ${t.name}'s cash-out — it's out of the queue, so no one else will pay it. Adjust or pay it, then \`/resumewithdraw\` when you're done.` });
}

export async function resumeWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const t = await ticketTarget(i); if (!t) return;
  try { await mutate(async (sql) => await sql`select withdraw_resume(${t.withdrawId}::uuid, ${a.id}::uuid)`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.reply({ ephemeral: false, content: `▶️ Resumed ${t.name}'s cash-out — it's back in the queue at its original place.` });
}

/** /reversepayment — a payment we already sent was fake. Un-sends it: the amount
 *  goes back onto what the player is owed (total unchanged), re-opening the cash-
 *  out even if this was the final payment. The club absorbs it. Targets the
 *  player's most recent released payment (works even on a completed cash-out). */
export async function reversePayment(i: ChatInputCommandInteraction): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const [pl] = await db()<{ id: string; display_name: string | null }[]>`
    select p.id, p.display_name from players p join discord_players dp on dp.player_id = p.id
     where dp.ticket_channel_id = ${i.channelId}`;
  if (!pl) return void (await i.reply({ ephemeral: true, content: "No player is linked to this channel, so there's nothing to reverse here." }));
  // List the recent SENT payments so the admin picks the fake one — it may not be
  // the most recent (could be the 2nd or 3rd back).
  const n = Math.min(20, Math.max(1, i.options.getInteger('count') ?? 10));
  const fills = await db()<{ id: string; amount: number; released_at: string | null }[]>`
    select f.id, f.amount, f.released_at from fills f join withdraw_requests w on w.id = f.withdraw_id
     where w.player_id = ${pl.id} and f.status = 'released'
     order by f.released_at desc nulls last, f.created_at desc limit ${n}`;
  if (fills.length === 0) return void (await i.reply({ ephemeral: true, content: `${pl.display_name ?? 'This player'} has no sent payment to reverse.` }));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let row = new ActionRowBuilder<ButtonBuilder>();
  fills.forEach((f, idx) => {
    if (idx > 0 && idx % 5 === 0) { rows.push(row); row = new ActionRowBuilder<ButtonBuilder>(); }
    const day = f.released_at ? ' · ' + new Date(f.released_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    row.addComponents(new ButtonBuilder().setCustomId(`rvp:${f.id}`).setLabel(`↩️ ${money(f.amount)}${day}`.slice(0, 80)).setStyle(ButtonStyle.Secondary));
  });
  rows.push(row);
  await i.reply({ ephemeral: true, content: `Which payment to **${pl.display_name ?? 'this player'}** should I reverse? Tap the fake one:`, components: rows.slice(0, 5) });
}

/** The admin tapped a specific payment to reverse (button rvp:<fill_id>). */
export async function reversePaymentPick(i: ButtonInteraction, fillId: string): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const [pre] = await db()<{ amount: number }[]>`select amount from fills where id = ${fillId}`;
  try { await mutate(async (sql) => await sql`select fill_reverse(${fillId}::uuid, ${a.id}::uuid, 'admin reversal')`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  const [w] = await db()<{ amount: number; amount_remaining: number; name: string | null }[]>`
    select w.amount, w.amount_remaining, p.display_name as name
      from withdraw_requests w join fills fl on fl.withdraw_id = w.id join players p on p.id = w.player_id where fl.id = ${fillId}`;
  await i.update({ content: `↩️ Reversed the **${money(pre?.amount ?? 0)}** payment to ${w?.name ?? 'the player'} — back on their cash-out (now ${money(w?.amount_remaining ?? 0)}/${money(w?.amount ?? 0)} to be sent). The club absorbed it; they've been told.`, components: [] });
}

/** /adjust amount:<±$> [receipt:<img>] — +grows the cash-out; − records a payment
 *  you made (receipt required). */
export async function adjustCmd(i: ChatInputCommandInteraction): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const dollars = i.options.getNumber('amount', true);
  const cents = Math.round(Math.abs(dollars) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return void (await i.reply({ ephemeral: true, content: 'Enter a non-zero amount, e.g. `50` or `-50`.' }));
  }
  const t = await ticketTarget(i); if (!t) return;

  if (dollars > 0) {
    try {
      const [r] = await mutate(async (sql) => sql<{ amount: number; amount_remaining: number; currency: string }[]>`
        select amount, amount_remaining, currency from withdraw_adjust(${t.withdrawId}::uuid, ${cents}::bigint, ${a.id}::uuid, 'admin /adjust')`);
      await i.reply({ ephemeral: false, content: `✅ Added ${money(cents, r!.currency)} to ${t.name}'s cash-out — now **${money(r!.amount, r!.currency)}** (${money(r!.amount_remaining, r!.currency)} still to pay). The player was told.` });
    } catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
    return;
  }

  // Negative → record a payment you made. Receipt required.
  const receipt = i.options.getAttachment('receipt');
  if (!receipt) {
    return void (await i.reply({ ephemeral: true, content: 'To record a payment, attach the payment screenshot: `/adjust amount:-50 receipt:<image>`.' }));
  }
  await i.deferReply({ ephemeral: false });
  // Copy the screenshot into durable storage (Discord CDN links expire) so it
  // survives in the player's /payments history.
  let receiptUrl = receipt.url;
  if (storageConfigured()) {
    try {
      const res = await fetch(receipt.url);
      const stored = await uploadReceipt(Buffer.from(await res.arrayBuffer()), receipt.contentType ?? 'image/jpeg', 'fill', t.withdrawId);
      receiptUrl = stored.url;
    } catch { /* fall back to the CDN url */ }
  }
  try {
    await mutate(async (sql) => await sql`select withdraw_club_payout(${t.withdrawId}::uuid, ${a.id}::uuid, ${cents}::bigint, null, 'paid via /adjust', ${receiptUrl})`);
  } catch (e) { if (isUserError(e)) return void (await i.editReply({ content: `❌ ${userMessage(e)}` })); throw e; }
  await i.editReply({ content: `✅ Recorded ${money(cents)} paid to ${t.name} — the receipt was sent to them and their cash-out reduced.` });
}

/**
 * /paymentchannel · /adminchannel — designate the current channel. The payments
 * feed (detected money-in) goes to the payments channel; everything else to the
 * admin channel. Admins only.
 */
export async function setChannel(i: ChatInputCommandInteraction, which: 'payments' | 'admin'): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  const [row] = await db()<{ discord_channel_set: boolean }[]>`
    select discord_channel_set(${which}, ${i.channelId}, ${i.user.id})`;
  if (!row?.discord_channel_set) return void (await i.reply({ ephemeral: true, content: '⛔ Only an admin can do that.' }));
  await i.reply({
    ephemeral: false,
    content: which === 'payments'
      ? '✅ This channel is now the **payments feed** — every detected payment lands here.'
      : '✅ This channel is now the **admin channel** (adjustments, verifications, and everything except the payments feed).',
  });
}

/**
 * /setadmin @user email [owner] — the owner makes someone an admin. Mirrors the
 * Telegram /setadmin: owner-only, an email is required (it is how they sign in to
 * the panel). A Discord mention hands us their user id directly, so no reply-trick
 * is needed. admin_upsert_discord links the Discord account to a shared admin row.
 */
export async function setAdmin(i: ChatInputCommandInteraction): Promise<void> {
  const [me] = await db()<{ id: string; role: string }[]>`
    select a.id, a.role from admins a
      join discord_admins da on da.admin_id = a.id
     where da.discord_id = ${i.user.id} and not a.disabled`;
  if (!me) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));
  if (me.role !== 'owner') return void (await i.reply({ ephemeral: true, content: 'Only the owner can add admins.' }));

  const target = i.options.getUser('user', true);
  const email = i.options.getString('email', true).trim();
  const wantsOwner = i.options.getBoolean('owner') ?? false;
  if (target.bot) return void (await i.reply({ ephemeral: true, content: "That's a bot — pick a person." }));
  const name = target.globalName ?? target.username;

  try {
    const [a] = await mutate(async (sql) => await sql<{ display_name: string | null; email: string; role: string }[]>`
      select display_name, email, role from admin_upsert_discord(
        ${target.id}, ${name}, ${email}, ${wantsOwner ? 'owner' : 'admin'}, ${me.id}::uuid)`);
    await i.reply({
      ephemeral: false,
      content:
        `✅ **${a!.display_name ?? name}** ${a!.role === 'owner' ? 'is now an owner' : 'is now an admin'}. ` +
        `They can act here right away. To use the website, they sign in with Google using ` +
        `**${a!.email}** — it links automatically.`,
    });
  } catch (e) { return void (await fail(i, e)); }
}

function amountModal(customId: string, label: string): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle(label)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true)));
}
function parseCents(s: string): number | null {
  const m = /^\+?(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim().replace(/[$,\s]/g, ''));
  if (!m) return null;
  const c = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  return c > 0 ? c : null;
}
