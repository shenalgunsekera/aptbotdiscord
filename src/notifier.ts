import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  type Client, type TextBasedChannel,
} from 'discord.js';
import { db } from './db.js';
import { money } from './words.js';
import type { Notification } from './core/index.js';

/**
 * Drains the SHARED notification outbox — but only the rows tagged
 * platform='discord' (see d0001). Player rows go to that player's ticket channel
 * (discord_players.ticket_channel_id); admin rows go to config.discord_admin_channel_id.
 *
 * Same atomic-lease pattern as the Telegram bot so a restart or an overlapping
 * tick can never send a row twice.
 */
export class Notifier {
  private timer?: NodeJS.Timeout;
  constructor(private client: Client, private pollMs = 3000) {}

  start(): void {
    const loop = async () => {
      try { await this.tick(); } catch (e) { console.error('[notify] tick failed:', e); }
      this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); }

  async tick(): Promise<number> {
    const sql = db();
    const [cfg] = await sql<{ discord_admin_channel_id: string | null; discord_payments_channel_id: string | null }[]>`
      select discord_admin_channel_id, discord_payments_channel_id from config where id`;

    const rows = await sql<Notification[]>`
      with c as (
        select id from notifications
         where platform = 'discord' and status = 'pending' and send_after <= now()
         order by id limit 15 for update skip locked
      )
      update notifications n set send_after = now() + interval '90 seconds'
        from c where n.id = c.id
      returning n.*`;
    if (rows.length === 0) return 0;

    const chans = await sql<{ id: number; channel: string | null }[]>`
      select n.id, dp.ticket_channel_id as channel from notifications n
        left join discord_players dp on dp.player_id = n.player_id
       where n.id = any(${sql.array(rows.map((r) => Number(r.id)))}::bigint[])`;
    const chanFor = new Map(chans.map((c) => [Number(c.id), c.channel]));

    let sent = 0;
    for (const n of rows) {
      const channelId = n.audience === 'admins'
        ? ((n.kind === 'payment.detected' ? cfg?.discord_payments_channel_id : null) ?? cfg?.discord_admin_channel_id)
        : chanFor.get(Number(n.id));
      const rendered = render(n);
      if (!channelId || !rendered) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
      try {
        const ch = await this.client.channels.fetch(channelId);
        if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error('not a sendable channel');
        const sentMsg = await (ch as TextBasedChannel & { send: Function }).send(rendered);
        await sql`update notifications set status='sent', sent_at=now(),
                  sent_chat_id=${String(channelId)}, sent_message_id=${sentMsg?.id ?? null} where id=${n.id}`;
        sent++;
      } catch (err) {
        const desc = String((err as Error)?.message ?? err);
        const giveUp = /Unknown Channel|Missing Access|Missing Permissions/i.test(desc) || n.attempts >= 4;
        await sql`update notifications set status=${giveUp ? 'failed' : 'pending'}, attempts=${n.attempts + 1},
                  last_error=${desc.slice(0, 300)}, send_after=now()+interval '2 minutes' where id=${n.id}`;
      }
    }
    return sent;
  }
}

interface Rendered { content?: string; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }
const btn = (label: string, id: string, style = ButtonStyle.Success) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...b: ButtonBuilder[]) => [new ActionRowBuilder<ButtonBuilder>().addComponents(...b)];
const imgEmbeds = (urls: string[]) => urls.filter(Boolean).slice(0, 4).map((u) => new EmbedBuilder().setImage(u));

/** Edit an already-delivered admin card in place (so a cancellation updates the
 *  Claim card instead of posting a new message). Uses the channel + message id the
 *  notifier recorded when it delivered the card. Best-effort. */
export async function editDiscordCard(
  client: Client, refType: string, refId: string, content: string,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<boolean> {
  const [n] = await db()<{ sent_chat_id: string | null; sent_message_id: string | null }[]>`
    select sent_chat_id, sent_message_id from notifications
     where ref_type = ${refType} and ref_id = ${refId}::uuid and platform = 'discord'
       and status = 'sent' and sent_message_id is not null order by id desc limit 1`;
  if (!n?.sent_chat_id || !n.sent_message_id) return false;
  try {
    const ch = await client.channels.fetch(n.sent_chat_id);
    if (!ch || !ch.isTextBased() || !('messages' in ch)) return false;
    const msg = await (ch as { messages: { fetch: (id: string) => Promise<{ edit: (o: unknown) => Promise<unknown> }> } }).messages.fetch(n.sent_message_id);
    await msg.edit({ content, components });
    return true;
  } catch { return false; }
}

/** Notification → Discord message. Ported from the Telegram renderer; Telegram
 *  `*bold*` becomes Discord `**bold**`, buttons become components. */
export function render(n: Notification): Rendered | null {
  const p = n.payload as Record<string, any>;
  const m = (v: unknown, c?: unknown) => money(Number(v ?? 0), String(c ?? 'USD'));

  switch (n.kind) {
    // ── Player-facing ──
    case 'fill.receipt_payee':
    case 'fill.confirm_request':
      return { content: `💰 **A payment of ${m(p.amount, p.currency)} is on the way to you.** We'll confirm it and let you know.` };
    case 'fill.released':
      return { content: `✅ **${m(p.credit, p.currency)} is on its way to your table.**` };
    case 'fill.settled':
      return { content: `✅ **${m(p.amount, p.currency)} — that part of your cash-out is done.**` };
    case 'fill.lock_expired':
      return { content: `⏱ **Your payment timed out.** The ${m(p.amount, p.currency)} went back in the queue. If you already sent it, message us now.` };
    case 'withdraw.queued':
      return {
        content: (p.short
          ? `✅ We got **${m(p.amount, p.currency)}** off your table (of the ${m(p.requested, p.currency)} you asked for). You're in line to be paid.`
          : `✅ **${m(p.amount, p.currency)}** is ready and you're in line to be paid.`),
        components: row(btn('✖️ Cancel this cash-out', `wd:retract:${n.ref_id}`, ButtonStyle.Danger)),
      };
    case 'withdraw.completed':
      return { content: `🎉 **Cash-out complete!** ${m(p.amount, p.currency)} — all done.` };
    case 'withdraw.cancelled':
      return { content: `Your cash-out was cancelled and everything's back where it was.` };
    case 'withdraw.cancel_confirmed':
      return { content: `✅ **Cancellation confirmed.** ${m(p.amount, p.currency)} has been put back on your table.` };
    case 'withdraw.paid':
      return { content: `💸 **You've been paid ${m(p.amount, p.currency)}!**` + (p.payment_ref ? `\nReference: \`${p.payment_ref}\`` : '') };
    case 'withdraw.reduced_player':
      return { content: `➖ **${m(p.back, p.currency)}** is coming back to your table. Your cash-out is now **${m(p.new_total, p.currency)}**.` };
    case 'withdraw.adjusted_player':
      return {
        content: Number(p.delta) > 0
          ? `➕ **${m(Number(p.delta), p.currency)}** was added to your cash-out — it's now **${m(p.new_total, p.currency)}**.` + (p.reason ? `\n_${p.reason}_` : '')
          : `➖ **${m(-Number(p.delta), p.currency)}** was taken off your cash-out — it's now **${m(p.new_total, p.currency)}**.` + (p.reason ? `\n_${p.reason}_` : ''),
      };
    case 'value.added':
      return { content: `🎰 **${m(p.delta, p.currency)} added to your account!**` };
    case 'value.taken':
      return { content: `📤 **${m(-Number(p.delta), p.currency)} taken off your table.**` };
    case 'player.linked':
      return { content: `Your ${p.platform} account (${p.uid}) is confirmed.` };
    case 'player.status_changed':
      return { content: p.status === 'active' ? `✅ Your account is active again.` : `Your account is now **${p.status}**.` + (p.reason ? `\n${p.reason}` : '') };

    // ── Admin channel ──
    case 'player.registered':
      return { content: `👤 **New player** — ${p.name ?? p.username ?? p.discord_id ?? 'unknown'}\nWaiting to add their account.` };
    case 'player.claim':
      return {
        content: `👤 **${p.name}** wants to link ${p.platform}: \`${p.uid_claimed}\`` +
          (p.username ? `\nUsername: \`${p.username}\`` : '') + `\nCheck the ID, then approve.`,
        components: p.pp_id ? row(btn('✅ Approve', `pl:approve:${p.pp_id}`)) : undefined,
      };
    case 'player.needs_club':
      return { content: `📍 **${p.name}** (${p.platform} ${p.uid}) is approved but not assigned to a club yet.` };
    case 'loader.work': {
      const load = Number(p.delta) > 0;
      const reload = p.reason === 'withdraw.cancel_reload';
      return {
        content: reload
          ? `↩️ **Player cancelled a cash-out — re-load ${m(Math.abs(Number(p.delta)), p.currency)}**\n` +
            `Player: **${p.player_name}**\nID: \`${p.platform_uid}\`\nClub: ${p.club}\n\nPut it back on their table, then mark done.`
          : `🎰 **${load ? 'ADD' : 'TAKE OFF'} ${m(Math.abs(Number(p.delta)), p.currency)}**\n` +
            `Player: **${p.player_name}**\nID: \`${p.platform_uid}\`\nClub: ${p.club}\nReason: ${p.reason}`,
        components: row(btn('✋ Claim', `lo:claim:${n.ref_id}`, ButtonStyle.Primary)),
      };
    }
    case 'fill.club_review':
    case 'fill.needs_review':
      return {
        content: `🏦 **Money to verify** (${p.method})\n${m(p.amount, p.currency)}${p.payment_ref ? ` — ref \`${p.payment_ref}\`` : ''}\nCheck it landed, then Verify — or Discard if it didn't.`,
        components: row(btn('✅ Verify', `fv:verify:${n.ref_id}`), btn('🗑 Discard', `fv:discard:${n.ref_id}`, ButtonStyle.Danger)),
      };
    case 'fill.receipt_admin': {
      const urls: string[] = (Array.isArray(p.urls) ? p.urls : [p.url]).filter((u: string) => u && !String(u).startsWith('telegram:'));
      return {
        content: `🏦 **Payment to verify — receipt${urls.length > 1 ? 's' : ''} attached**\n` +
          `${p.name ? 'From: **' + p.name + '**\n' : ''}Amount: **${m(p.amount, p.currency)}** (${p.method})` +
          (p.payout_handle ? `\nTo: \`${p.payout_handle}\`` : '') +
          (p.payout_name ? `\nName: **${p.payout_name}**` : '') +
          (p.payment_ref ? `\nReference: \`${p.payment_ref}\`` : '') + `\nCheck it landed, then Verify — or Discard if it didn't.`,
        embeds: imgEmbeds(urls),
        components: row(btn('✅ Verify', `fv:verify:${p.fill_id}`), btn('🗑 Discard', `fv:discard:${p.fill_id}`, ButtonStyle.Danger)),
      };
    }
    case 'payment.detected': {
      const icon = p.source === 'paypal' ? '💚' : p.source === 'cashapp' ? '💵' : p.source === 'stripe' ? '💳' : '🪙';
      if (p.kind === 'request' || p.request)
        return { content: `${icon}🧾 **Payment request** — ${m(p.amount, p.currency)} via ${p.method}` + (p.name ? `\nFrom: **${p.name}**` : '') + `\n_Pay it if it matches a cash-out._` };
      if (p.kind === 'cancel')
        return { content: `${icon}🚫 **Request cancelled** — ${m(p.amount, p.currency)} via ${p.method}` + (p.name ? `\nFrom: **${p.name}**` : '') + `\n_No action needed._` };
      return { content: `${icon} **Payment received** — ${m(p.amount, p.currency)} via ${p.method}` + (p.name ? `\nFrom: **${p.name}**` : '') + `\n_Match it to the player's receipt, then credit them._` };
    }
    case 'stripe.claim':
      return {
        content: `🍎 **Card / Apple Pay receipt — from ${p.name ?? 'a player'}**\n` +
          (p.amount ? `Matched payment: **${m(p.amount, p.currency)}**. Check the receipt, then credit.` : `Enter the amount from the "Payment received" alert to credit.`),
        embeds: imgEmbeds([p.url].filter(Boolean)),
        components: p.amount ? row(btn(`✅ Verify & Credit ${m(p.amount, p.currency)}`, `st:ok:${p.claim_id}`)) : row(btn('💵 Credit (enter amount)', `st:credit:${p.claim_id}`, ButtonStyle.Primary)),
      };
    case 'withdraw.retracted':
      return { content: `↩️ **Cash-out cancelled by ${p.name ?? 'a player'}** — **${m(p.amount, p.currency)}** had already come off their table; **re-load it** to reimburse.` };
    case 'withdraw.reduced':
      return { content: `➖ **Cash-out lowered by ${p.name ?? 'a player'}** — they took **${m(p.amount, p.currency)}** back (now ${m(p.new_total, p.currency)}). **Re-load ${m(p.amount, p.currency)}**.` };
    case 'withdraw.adjusted':
      return { content: `✏️ **Cash-out adjusted for ${p.name ?? 'a player'}** — ${Number(p.delta) > 0 ? 'added' : 'removed'} **${m(Math.abs(Number(p.delta)), p.currency)}** (now ${m(p.new_total, p.currency)}).` + (p.reason ? `\n_Reason: ${p.reason}_` : '') };
    case 'sportsbook.create':
      return {
        content: `🆕 **Create a Sportsbook account**\nFor: **${p.name}**\nUsername: \`${p.username}\`\nPassword: \`${p.password}\`\nCreate it, then tap below.`,
        components: row(btn('✅ Account created', `sb:made:${p.player_id}`)),
      };
    case 'withdraw.needs_payout':
      return String(p.method).toLowerCase().includes('paypal')
        ? { content: `💸 **PayPal cash-out — approve a request**\nFrom: **${p.name}**\nAmount: **${m(p.amount, p.currency)}**\nApprove & pay their money request, then tap below.`, components: row(btn('✅ I paid it', `wd:pay:${p.withdraw_id}`)) }
        : { content: `💸 **Cash-out to pay** (${p.method})\n${p.name ? 'To: **' + p.name + '**\n' : ''}Amount: **${m(p.amount, p.currency)}**\nSend to: \`${p.handle}\` _(tap to copy)_\nPay it, then tap below.`, components: row(btn('✅ I paid it', `wd:pay:${p.withdraw_id}`)) };
    case 'loader.delivery_failed':
      return { content: `⚠️ **Couldn't add value** to ${p.player_name} (\`${p.platform_uid}\`) — ${m(p.delta, p.currency)}\n_${p.reason}_ — needs a human.` };
    default:
      return null;
  }
}
