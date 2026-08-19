import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { db } from '../db.js';
import { currentPlayer } from '../identity.js';
import { money, friendlyStatus } from '../words.js';
import { say } from '../flows.js';

const GUIDE =
  '📖 **What each command does**\n\n' +
  '💵 `/deposit` — add money to your account. Pick where it goes, how you\'re paying, and the amount.\n' +
  '✖️ `/canceldeposit` — cancel your most recent deposit if you haven\'t paid yet.\n' +
  '💸 `/withdraw` — cash-out. We take it off your table and pay you the way you\'ve set up.\n' +
  '✖️ `/cancelwithdraw` — cancel a cash-out that hasn\'t been paid yet.\n' +
  '⏳ `/pending` — see deposits and cash-outs still in progress, and cancel a cash-out if you need to.\n' +
  '📄 `/payments` — your history of completed payments and receipts.\n\n' +
  '**Change your setup anytime:**\n' +
  '➕ `/editplatform` — add or remove ClubGG / Sportsbook.\n' +
  '🏆 `/editclubs` — change which clubs you play in.\n' +
  '💳 `/editdeposit` — change which payment methods you deposit with.\n' +
  '🏦 `/editwithdraw` — change which payment methods you cash-out with.\n\n' +
  '💬 `/support` — message our team directly.';

export async function guide(i: ChatInputCommandInteraction): Promise<void> {
  await i.reply({ ephemeral: true, content: GUIDE });
}

export async function support(i: ChatInputCommandInteraction): Promise<void> {
  await i.reply({ ephemeral: false, content: '💬 Post your question right here — our team sees this ticket and will get back to you.' });
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
 * /payments — the player's own money tracker (ported from the Telegram bot).
 *
 * A $100 cash-out paid as 50 + 25 + 25 by three different people is three
 * payments, and the player must be able to see each one AND its receipt any
 * time — including a cross-platform payout, where a Telegram payer settles this
 * Discord player's cash-out. player_payments()/player_deposits() are scoped to
 * this player's id, so a player never sees another player's payments or receipts.
 *
 * ONGOING first, in full detail with receipts; a few recently-finished follow,
 * receipts still linked. The actual receipt IMAGES are posted for what a player
 * is actively watching (everything in progress + the single most recent finished
 * cash-out), so a Discord player can view the screenshot(s) they were paid with.
 */
const ONGOING_WD = new Set(['pending_unload', 'queued', 'partially_filled', 'filled']);
const ONGOING_DEP = new Set(['matching', 'awaiting_payment', 'awaiting_confirmation']);

export async function payments(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  // Two queries + image embeds can exceed Discord's 3s ack window; defer first.
  await i.deferReply({ ephemeral: true });

  const outs = await db()<any[]>`select * from player_payments(${p.id}::uuid) limit 25`;
  const deps = await db()<any[]>`select * from player_deposits(${p.id}::uuid) limit 25`;

  if (!outs.length && !deps.length) {
    await i.editReply("You haven't added or cashed out any money yet. Use `/deposit` or `/withdraw` to start.");
    return;
  }

  // Only show payments that actually went through — never cancelled/expired ones.
  const outOngoing = outs.filter((w) => ONGOING_WD.has(w.status));
  const outDone = outs.filter((w) => w.status === 'completed').slice(0, 3);
  const depOngoing = deps.filter((d) => ONGOING_DEP.has(d.status));
  const depDone = deps.filter((d) => d.status === 'completed').slice(0, 3);

  const lines: string[] = [];
  if (outOngoing.length) {
    lines.push('**💸 Cash-outs in progress**');
    for (const w of outOngoing) lines.push(renderCashout(w));
  }
  if (depOngoing.length) {
    lines.push('**💵 Money you\'re adding**');
    for (const d of depOngoing) lines.push(renderDeposit(d));
  }
  if (outDone.length || depDone.length) {
    lines.push('**✅ Recently finished**');
    for (const w of outDone) lines.push(renderCashout(w, true));
    for (const d of depDone) lines.push(renderDeposit(d, true));
  }
  if (!lines.length) {
    const done = outs.filter((w) => w.status === 'completed').slice(0, 5);
    if (done.length) {
      lines.push('**Your recent payments**');
      for (const w of done) lines.push(renderCashout(w, true));
    } else {
      lines.push('No completed payments yet.');
    }
  }

  // Receipt IMAGES for what a player is actively watching: everything in
  // progress plus the SINGLE most recent finished cash-out. Older ones keep
  // their receipt LINK in the text above so nothing becomes unreachable.
  const seen = new Set<string>();
  const mostRecentDone = outs.find((w) => w.status === 'completed');
  const showable = [...outOngoing, ...(mostRecentDone ? [mostRecentDone] : [])];
  const imgUrls: string[] = [];
  for (const w of showable) {
    for (const pay of (w.payments ?? []) as any[]) {
      const url = pay.receipt;
      // Discord can only render an http(s) image URL inline; a Telegram-only
      // file_id ("telegram:…") stays as its text link above.
      if (!url || !String(url).startsWith('http') || seen.has(url)) continue;
      seen.add(url);
      imgUrls.push(url);
    }
  }

  const summary = new EmbedBuilder().setTitle('Your payments')
    .setDescription(lines.join('\n').trim().slice(0, 4096));
  // One message: summary embed + up to 9 receipt-image embeds (Discord caps at 10).
  const embeds = [summary, ...imgUrls.slice(0, 9).map((u) => new EmbedBuilder().setImage(u))];
  await i.editReply({ embeds });
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
    const withReceipts = pays.filter((x) => x.receipt);
    for (const [idx, pay] of withReceipts.entries()) {
      out.push(`  📄 [Receipt ${pay.receipt_ref ?? idx + 1}](${pay.receipt}) — ${money(pay.amount)}`);
    }
  }
  return out.join('\n');
}

function renderDeposit(d: any, brief = false): string {
  const out: string[] = [`**${money(d.amount)}** via ${d.method} — _${friendlyStatus('deposit', d.status)}_`];
  const pays = (d.payments ?? []) as any[];
  for (const [idx, pay] of pays.entries()) {
    if (brief && !pay.receipt) continue;
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
    (pay.receipt ? `\n     📄 [Receipt ${pay.receipt_ref ?? ''}](${pay.receipt})` : '')
  );
}
