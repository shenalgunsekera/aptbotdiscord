import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle,
  type ButtonInteraction, type ModalSubmitInteraction, type ChatInputCommandInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentAdmin } from '../identity.js';
import { ses } from '../session.js';
import { money } from '../words.js';

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
  try { await mutate(async (sql) => await sql`select fill_admin_verify(${fillId}::uuid, ${a.id}::uuid, 'verified via discord')`); } catch (e) { return void (await fail(i, e)); }

  const [o] = await db()<{ id: string; delta: number; currency: string; player_name: string; platform_uid: string }[]>`
    select id, delta, currency, player_name, platform_uid from loader_orders
     where ref_type='fill' and ref_id=${fillId} order by created_at desc limit 1`;
  if (!o) return void (await i.update({ content: `✅ **Verified & released** · by ${i.user.username}`, components: [], embeds: [] }));

  try { await mutate(async (sql) => await sql`select loader_order_claim(${o.id}::uuid, ${a.id}::uuid)`); } catch { /* raced */ }
  await db()`update notifications set status='skipped' where kind='loader.work' and ref_type='loader_order' and ref_id=${o.id} and status='pending'`;
  const r = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lo:done:${o.id}:${o.delta}`).setLabel(`✅ Done — added ${money(o.delta, o.currency)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lo:fail:${o.id}`).setLabel('❌ Failed').setStyle(ButtonStyle.Danger),
  );
  await i.update({ content: `🎰 **ADD ${money(o.delta, o.currency)}** to their table — Player: **${o.player_name}** \`${o.platform_uid}\`\n_Claimed by ${i.user.username}._ Add it, then:`, components: [r] });
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
  try { await mutate(async (sql) => await sql`select loader_order_claim(${orderId}::uuid, ${a.id}::uuid)`); } catch (e) { return void (await fail(i, e)); }
  const [o] = await db()<{ delta: number; currency: string; player_name: string; platform_uid: string }[]>`
    select delta, currency, player_name, platform_uid from loader_orders where id = ${orderId}`;
  if (!o) return;
  const load = o.delta > 0;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const r = new ActionRowBuilder<ButtonBuilder>();
  r.addComponents(new ButtonBuilder().setCustomId(`lo:done:${orderId}:${o.delta}`).setLabel(load ? `✅ Done — added ${money(o.delta, o.currency)}` : `✅ All ${money(-o.delta, o.currency)}`).setStyle(ButtonStyle.Success));
  if (!load) r.addComponents(new ButtonBuilder().setCustomId(`lo:short:${orderId}`).setLabel('✏️ Different amount').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`lo:done:${orderId}:0`).setLabel('❌ Nothing there').setStyle(ButtonStyle.Secondary));
  else r.addComponents(new ButtonBuilder().setCustomId(`lo:fail:${orderId}`).setLabel('❌ Failed').setStyle(ButtonStyle.Danger));
  rows.push(r);
  await i.update({ content: `🎰 **${load ? 'ADD' : 'TAKE OFF'} ${money(Math.abs(o.delta), o.currency)}** — Player: **${o.player_name}** \`${o.platform_uid}\`\n_Claimed by ${i.user.username}._ Tap the amount you actually ${load ? 'added' : 'took off'}:`, components: rows });
}

export async function loaderDone(i: ButtonInteraction, orderId: string, delta: number): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select loader_order_complete(${orderId}::uuid, ${a.id}::uuid, ${delta}::bigint, 'via discord')`); } catch (e) { return void (await fail(i, e)); }
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
  await i.reply({ ephemeral: true, content: '📸 Post a **screenshot** of the payment you sent here — the player gets it as their receipt.\n\n_No screenshot? Just type the transaction ID instead._' });
}

/** The admin's next message after "I paid it": an image (receipt, forwarded to
 *  the player) or text (a plain reference). */
export async function payReceipt(msg: Message): Promise<void> {
  const s = ses(msg.author.id);
  const withdrawId = s.payWithdrawId;
  const a = await currentAdmin(msg.author.id);
  const img = msg.attachments.find((at) => (at.contentType ?? '').startsWith('image/')) ?? msg.attachments.first();
  const url = img?.url ?? null;
  const text = msg.content.trim();
  if (!url && !text) return void (await msg.reply('Post a screenshot of the payment, or type the transaction ID.'));
  s.pending = undefined;
  s.payWithdrawId = undefined;
  if (!withdrawId || !a) return;
  try {
    await mutate(async (sql) => await sql`select withdraw_club_payout(${withdrawId}::uuid, ${a.id}::uuid, null,
                                          ${url ? null : text}, 'paid via discord', ${url})`);
  } catch (e) { return void (await fail2(msg, e)); }
  await msg.reply(url ? '✅ Recorded as paid — the receipt was sent to the player.' : `✅ Recorded as paid (ref \`${text}\`). The player has been told.`);
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
  await done(i, `✅ **Credited** · by ${i.user.username}`);
}
export async function stripeCredit(i: ButtonInteraction, claimId: string): Promise<void> {
  if (!(await admin(i))) return;
  await i.showModal(amountModal(`st:creditamt:${claimId}`, 'Amount to credit'));
}
export async function stripeCreditAmount(i: ModalSubmitInteraction, claimId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const cents = parseCents(i.fields.getTextInputValue('amount'));
  if (cents === null) return void (await i.reply({ ephemeral: true, content: 'Send just the number, e.g. `50`.' }));
  try { await mutate(async (sql) => await sql`select stripe_claim_credit(${claimId}::uuid, ${a.id}::uuid, ${cents}::bigint)`); } catch (e) { return void (await fail(i, e)); }
  await i.reply({ ephemeral: false, content: `✅ Credited ${money(cents)} · by ${i.user.username}` });
}

/**
 * /add · /remove — an admin corrects a player's OPEN cash-out from inside that
 * player's ticket channel. The player is found by the channel this is run in
 * (discord_players.ticket_channel_id), so there's no ID to type. Runs through
 * withdraw_adjust(): ledger-posted, audited, and the player is told.
 */
export async function adjust(i: ChatInputCommandInteraction, sign: 1 | -1): Promise<void> {
  const a = await currentAdmin(i.user.id);
  if (!a) return void (await i.reply({ ephemeral: true, content: 'Admins only.' }));

  const dollars = i.options.getNumber('amount', true);
  const reason = i.options.getString('reason') ?? null;
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return void (await i.reply({ ephemeral: true, content: 'Enter an amount above zero, e.g. `20`.' }));
  }

  const channelId = i.channelId;
  const [pl] = await db()<{ id: string; display_name: string | null }[]>`
    select p.id, p.display_name from players p
      join discord_players dp on dp.player_id = p.id
     where dp.ticket_channel_id = ${channelId}`;
  if (!pl) {
    return void (await i.reply({ ephemeral: true, content: "No player is linked to this channel, so there's nothing to adjust here." }));
  }
  const who = pl.display_name ?? 'this player';

  const [w] = await db()<{ id: string }[]>`
    select id from withdraw_requests
     where player_id = ${pl.id} and status in ('queued', 'partially_filled', 'filled')
     order by created_at desc limit 1`;
  if (!w) {
    return void (await i.reply({ ephemeral: true, content: `${who} has no cash-outs in progress — nothing to adjust.` }));
  }

  try {
    const [r] = await db()<{ amount: number; amount_remaining: number; currency: string }[]>`
      select amount, amount_remaining, currency
        from withdraw_adjust(${w.id}::uuid, ${sign * cents}::bigint, ${a.id}::uuid, ${reason})`;
    await i.reply({
      ephemeral: false,
      content: `✅ ${sign > 0 ? 'Added' : 'Removed'} ${money(cents, r!.currency)} ${sign > 0 ? 'to' : 'from'} ${who}'s cash-out. ` +
        `New total: **${money(r!.amount, r!.currency)}** (${money(r!.amount_remaining, r!.currency)} still to pay). The player has been told.`,
    });
  } catch (e) { return void (await fail(i, e)); }
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
