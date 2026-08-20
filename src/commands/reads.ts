import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { db } from '../db.js';
import { currentPlayer } from '../identity.js';
import { money, friendlyStatus } from '../words.js';
import { say } from '../flows.js';
import { clearSes } from '../session.js';

const GUIDE =
  '📖 **What each command does**\n\n' +
  '💵 `/deposit` — add money to your account. Pick where it goes, how you\'re paying, and the amount.\n' +
  '✖️ `/canceldeposit` — cancel your most recent deposit if you haven\'t paid yet.\n' +
  '💸 `/withdraw` — cash-out. We take it off your table and pay you the way you\'ve set up.\n' +
  '✖️ `/cancelwithdraw` — cancel a cash-out that hasn\'t been paid yet.\n' +
  '➕ `/addtowithdraw` — add more to a cash-out already in the queue, keeping your place in line.\n' +
  '⏳ `/pending` — see deposits and cash-outs still in progress, and cancel a cash-out if you need to.\n' +
  '📄 `/withdrawalhistory` — the cash-outs paid to you, with every receipt.\n' +
  '📥 `/deposithistory` — the deposits you\'ve made, with every receipt.\n\n' +
  '**Change your setup anytime:**\n' +
  '➕ `/editplatform` — add or remove ClubGG / Sportsbook.\n' +
  '🏆 `/editclubs` — change which clubs you play in.\n' +
  '💳 `/editdeposit` — change which payment methods you deposit with.\n' +
  '🏦 `/editwithdraw` — change which payment methods you cash-out with.\n\n' +
  '💬 `/support` — message our team directly.\n' +
  '🛑 `/stop` — stop whatever you\'re in the middle of.';

export async function guide(i: ChatInputCommandInteraction): Promise<void> {
  await i.reply({ ephemeral: true, content: GUIDE });
}

export async function support(i: ChatInputCommandInteraction): Promise<void> {
  await i.reply({ ephemeral: false, content: '💬 Post your question right here — our team sees this ticket and will get back to you.' });
}

/** /stop — bail out of whatever flow the player is mid-way through. Clears the
 *  in-memory pending state (amount/handle/etc.); durable data is never touched. */
export async function stop(i: ChatInputCommandInteraction): Promise<void> {
  clearSes(i.user.id);
  await i.reply({ ephemeral: true, content: 'Okay, stopped. 👍' });
}

/** /pending — what's in motion. No available balance; only real movement. */
export async function pending(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to get set up first.'));
  const lines: string[] = [];

  const [sum] = await db()<{ awaiting_payment: number; being_confirmed: number }[]>`
    select awaiting_payment, being_confirmed from v_player_summary where player_id = ${p.id}`;
  if (sum && (sum.awaiting_payment > 0 || sum.being_confirmed > 0)) {
    lines.push('**Money coming to you**');
    if (sum.awaiting_payment > 0) lines.push(`  ${money(sum.awaiting_payment)} — waiting to be paid`);
    if (sum.being_confirmed > 0) lines.push(`  ${money(sum.being_confirmed)} — being checked`);
    lines.push('');
  }

  const deps = await db()<{ amount: number; currency: string; status: string }[]>`
    select amount, currency, status from deposit_requests
     where player_id = ${p.id} and status in ('matching','awaiting_payment','awaiting_confirmation') order by created_at`;
  const outs = await db()<{ id: string; requested_amount: number; amount: number | null; currency: string; status: string; method_code: string }[]>`
    select w.id, w.requested_amount, w.amount, w.currency, w.status, pm.code as method_code
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.player_id = ${p.id} and w.status in ('pending_unload','queued','partially_filled','filled') order by w.created_at`;

  if (deps.length || outs.length) {
    lines.push('**In progress**');
    for (const d of deps) lines.push(`  ↓ Adding ${money(d.amount, d.currency)} — ${d.status.replace(/_/g, ' ')}`);
    for (const o of outs) lines.push(`  ↑ Cashing out ${money(o.amount ?? o.requested_amount, o.currency)} — ${o.status.replace(/_/g, ' ')}`);
    lines.push('');
  }
  if (!lines.length) lines.push('Nothing in progress right now.');

  // We don't push cancellation here — /pending just shows status. A player who
  // genuinely wants to cancel uses /cancelwithdraw.
  await i.reply({ ephemeral: true, content: lines.join('\n') });
}

/**
 * /withdrawalhistory — the cash-outs the player RECEIVED (money paid to them).
 * /deposithistory    — the deposits the player MADE (money they added).
 *
 * A $100 cash-out paid as 50 + 25 + 25 by three different people is three
 * payments, and the player must be able to see each one AND its receipt any
 * time — including a cross-platform payout, where a Telegram payer settles this
 * Discord player's cash-out. player_payments()/player_deposits() are scoped to
 * this player's id, so a player never sees another player's payments or receipts.
 *
 * ONGOING first, in full detail with receipts; a few recently-finished follow,
 * receipts still linked. The actual receipt IMAGES are posted so the player can
 * view the screenshot(s) — Discord renders an http(s) image URL inline (a
 * Telegram-only file_id can't be shown here and keeps its text label above).
 */
const ONGOING_WD = new Set(['pending_unload', 'queued', 'partially_filled', 'filled']);
const ONGOING_DEP = new Set(['matching', 'awaiting_payment', 'awaiting_confirmation']);

/** /withdrawalhistory — cash-outs paid to the player, with receipts. */
export async function withdrawalHistory(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  await i.deferReply({ ephemeral: true });

  const outs = await db()<any[]>`select * from player_payments(${p.id}::uuid) limit 25`;
  if (!outs.length) {
    await i.editReply("You haven't cashed out any money yet. Use `/withdraw` to start.");
    return;
  }

  const ongoing = outs.filter((w) => ONGOING_WD.has(w.status));
  const done = outs.filter((w) => w.status === 'completed').slice(0, 5);

  const lines: string[] = [];
  if (ongoing.length) { lines.push('**💸 Cash-outs in progress**'); for (const w of ongoing) lines.push(renderCashout(w)); }
  if (done.length) { lines.push('**✅ Recently paid**'); for (const w of done) lines.push(renderCashout(w, true)); }
  if (!lines.length) lines.push('No completed cash-outs yet.');

  const summary = new EmbedBuilder().setTitle('Cash-outs paid to you')
    .setDescription(lines.join('\n').trim().slice(0, 4096));
  const embeds = [summary, ...receiptImages([...ongoing, ...done])];
  await i.editReply({ embeds });
}

/** /deposithistory — deposits the player made, with receipts. */
export async function depositHistory(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  await i.deferReply({ ephemeral: true });

  const deps = await db()<any[]>`select * from player_deposits(${p.id}::uuid) limit 25`;
  if (!deps.length) {
    await i.editReply("You haven't added any money yet. Use `/deposit` to start.");
    return;
  }

  const ongoing = deps.filter((d) => ONGOING_DEP.has(d.status));
  const done = deps.filter((d) => d.status === 'completed').slice(0, 5);

  const lines: string[] = [];
  if (ongoing.length) { lines.push('**💵 Money you\'re adding**'); for (const d of ongoing) lines.push(renderDeposit(d)); }
  if (done.length) { lines.push('**✅ Recently added**'); for (const d of done) lines.push(renderDeposit(d, true)); }
  if (!lines.length) lines.push('No completed deposits yet.');

  const summary = new EmbedBuilder().setTitle('Deposits you made')
    .setDescription(lines.join('\n').trim().slice(0, 4096));
  const embeds = [summary, ...receiptImages([...ongoing, ...done])];
  await i.editReply({ embeds });
}

/** Up to 9 receipt-image embeds for the given items (Discord caps a message at
 *  10 embeds, one is the summary). Only http(s) urls render inline. */
function receiptImages(items: any[]): EmbedBuilder[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const it of items) {
    for (const pay of (it.payments ?? []) as any[]) {
      for (const rc of receiptsOf(pay)) {
        if (!String(rc.url).startsWith('http') || seen.has(rc.url)) continue;
        seen.add(rc.url);
        urls.push(rc.url);
      }
    }
  }
  return urls.slice(0, 9).map((u) => new EmbedBuilder().setImage(u));
}

function renderCashout(w: any, brief = false): string {
  const total = w.total_amount || w.requested;
  const paid = w.amount_paid ?? 0;
  const out: string[] = [
    `**${money(total)}** via ${w.method} — _${friendlyStatus('withdraw', w.status)}_` +
      (paid > 0 && paid < total ? `  (${money(paid)} / ${money(total)} paid)` : ''),
  ];
  const pays = (w.payments ?? []) as any[];
  if (pays.length && !brief) {
    for (const [idx, pay] of pays.entries()) out.push(payLine(idx, pay));
  } else if (pays.length && brief) {
    for (const pay of pays) {
      const links = receiptLinks(pay);
      if (links) out.push(`  💵 ${money(pay.amount)}${links}`);
    }
  }
  return out.join('\n');
}

/** Every receipt on a payment as {url, ref}. Prefers the new `receipts` array
 *  (all screenshots); falls back to the singular `receipt`/`receipt_ref`. */
function receiptsOf(pay: any): { url: string; ref?: string }[] {
  const list = Array.isArray(pay.receipts) && pay.receipts.length
    ? pay.receipts.map((r: any) => (typeof r === 'string' ? { url: r } : r))
    : (pay.receipt ? [{ url: pay.receipt, ref: pay.receipt_ref }] : []);
  return list.filter((r: any) => r?.url);
}

/** Receipt lines. Only an http(s) url becomes a clickable link — a Telegram
 *  file_id isn't a URL, so it's shown as plain text (the image can't render here). */
function receiptLinks(pay: any): string {
  return receiptsOf(pay).map((r) =>
    /^https?:\/\//i.test(r.url)
      ? `\n     📄 [Receipt ${r.ref ?? ''}](${r.url})`
      : `\n     📄 Receipt ${r.ref ?? ''}`,
  ).join('');
}

function renderDeposit(d: any, brief = false): string {
  const out: string[] = [`**${money(d.amount)}** via ${d.method} — _${friendlyStatus('deposit', d.status)}_`];
  const pays = (d.payments ?? []) as any[];
  for (const [idx, pay] of pays.entries()) {
    if (brief && receiptsOf(pay).length === 0) continue;
    out.push(payLine(idx, pay, pay.to));
  }
  return out.join('\n');
}

function payLine(idx: number, pay: any, to?: string): string {
  const tick = pay.status === 'released' ? '✅' : pay.status === 'disputed' ? '⏸' : '⏳';
  return (
    `  ${tick} Payment ${idx + 1}: **${money(pay.amount)}**` +
    (to ? ` to \`${to}\`` : '') +
    (pay.ref ? ` — ref \`${pay.ref}\`` : '') +
    receiptLinks(pay)
  );
}
