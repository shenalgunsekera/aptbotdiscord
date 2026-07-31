import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { db } from '../db.js';
import { currentPlayer } from '../identity.js';
import { money } from '../words.js';
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

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const cancellable = outs.filter((o) => ['pending_unload', 'queued', 'partially_filled'].includes(o.status));
  for (const o of cancellable.slice(0, 5)) {
    const r = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`wd:retract:${o.id}`).setLabel(`✖️ Cancel ${money(o.amount ?? o.requested_amount, o.currency)}`).setStyle(ButtonStyle.Danger));
    if (o.method_code !== 'paypal' && o.method_code !== 'cashapp' && ['queued', 'partially_filled'].includes(o.status))
      r.addComponents(new ButtonBuilder().setCustomId(`wd:reduce:${o.id}`).setLabel('➖ Take some back').setStyle(ButtonStyle.Secondary));
    rows.push(r);
  }
  await i.reply({ ephemeral: true, content: lines.join('\n'), components: rows });
}

/** /payments — completed history. */
export async function payments(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` first.'));
  const rows = await db()<{ kind: string; amount: number; currency: string; when: Date }[]>`
    select 'Added' as kind, amount, currency, completed_at as when from deposit_requests
      where player_id = ${p.id} and status = 'completed'
    union all
    select 'Cashed out' as kind, requested_amount as amount, currency, completed_at as when from withdraw_requests
      where player_id = ${p.id} and status = 'completed'
    order by when desc nulls last limit 15`;
  if (!rows.length) return void (await i.reply({ ephemeral: true, content: 'No completed payments yet.' }));
  const embed = new EmbedBuilder().setTitle('Your payments')
    .setDescription(rows.map((r) => `**${r.kind} ${money(r.amount, r.currency)}** — ${r.when ? new Date(r.when).toLocaleDateString() : ''}`).join('\n'));
  await i.reply({ ephemeral: true, embeds: [embed] });
}
