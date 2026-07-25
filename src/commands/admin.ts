import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle,
  type ButtonInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentAdmin } from '../identity.js';
import { money } from '../words.js';

async function admin(i: ButtonInteraction | ModalSubmitInteraction): Promise<{ id: string } | null> {
  const a = await currentAdmin(i.user.id);
  if (!a) { await i.reply({ ephemeral: true, content: 'Admins only.' }); return null; }
  return a;
}
async function fail(i: ButtonInteraction | ModalSubmitInteraction, e: unknown): Promise<void> {
  if (isUserError(e)) { await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` }); return; }
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

/** Verify & release a payment. */
export async function verify(i: ButtonInteraction, fillId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select fill_admin_verify(${fillId}::uuid, ${a.id}::uuid, 'verified via discord')`); } catch (e) { return void (await fail(i, e)); }
  await done(i, `✅ **Verified & released** · by ${i.user.username}`);
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
  await done(i, `✅ **Done** — ${delta === 0 ? 'nothing was available' : money(Math.abs(delta))} · by ${i.user.username}`);
}

export async function loaderFail(i: ButtonInteraction, orderId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  try { await mutate(async (sql) => await sql`select loader_order_fail(${orderId}::uuid, ${a.id}::uuid, 'marked failed via discord')`); } catch (e) { return void (await fail(i, e)); }
  await done(i, `❌ **Failed** · by ${i.user.username}`);
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

/** "I paid it" on a cash out → ask for the reference. */
export async function withdrawPay(i: ButtonInteraction, withdrawId: string): Promise<void> {
  if (!(await admin(i))) return;
  await i.showModal(new ModalBuilder().setCustomId(`wd:payref:${withdrawId}`).setTitle('Payment reference')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('ref').setLabel('Transaction ID / reference').setStyle(TextInputStyle.Short).setRequired(true))));
}
export async function withdrawPayRef(i: ModalSubmitInteraction, withdrawId: string): Promise<void> {
  const a = await admin(i); if (!a) return;
  const ref = i.fields.getTextInputValue('ref').trim();
  try { await mutate(async (sql) => await sql`select withdraw_club_payout(${withdrawId}::uuid, ${a.id}::uuid, null, ${ref}, 'paid via discord')`); } catch (e) { return void (await fail(i, e)); }
  await i.reply({ ephemeral: false, content: `✅ Recorded as paid (ref \`${ref}\`). The player has been told.` });
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
