import {
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ButtonInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses } from '../session.js';
import { money, whole, parseAmount, amountProblem, withdrawHandlePrompt, cashoutConfirm } from '../words.js';
import { confirmedPlatforms, payoutMethods, methodOption, say, sayChat, sendChannel, selectRow } from '../flows.js';
import type { PaymentMethod, WithdrawRequest } from '../core/index.js';

/** /withdraw — cash out. platform → club → amount(chat) → method → handle(chat) → queue. */
export async function withdraw(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to set up first.'));
  if (p.status !== 'active') return void (await say(i, "You're almost ready — we just need to confirm your account first."));
  const platforms = await confirmedPlatforms(p.id);
  if (platforms.length === 0) return void (await say(i, "You don't have a confirmed account on any platform yet. `/start` first."));
  if (platforms.length === 1) return void (await afterPlatform(i, platforms[0]!.id));
  await say(i, 'Where do you want to cash out from?', [selectRow('out:pf', 'Choose platform', platforms.map((pf) => ({ label: pf.name, value: pf.id })))]);
}

export async function onPlatform(i: StringSelectMenuInteraction): Promise<void> {
  await i.update({ components: [] });
  await afterPlatform(i, i.values[0]!);
}

async function afterPlatform(i: ChatInputCommandInteraction | StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  ses(i.user.id).outPlatform = platformId;
  const clubs = await db()<{ id: string; name: string }[]>`
    select c.id, c.name from clubs c join player_clubs pc on pc.club_id = c.id
     where pc.player_id = ${p.id} and c.platform_id = ${platformId} and c.enabled order by c.name`;
  if (clubs.length > 1) return void (await say(i, 'Which club are you cashing out from?', [selectRow('out:club', 'Choose club', clubs.map((c) => ({ label: c.name, value: c.id })))]));
  if (clubs.length === 1) await mutate(async (sql) => await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${clubs[0]!.id}::uuid)`);
  await promptAmount(i);
}

export async function onClub(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const platformId = ses(i.user.id).outPlatform!;
  try { await mutate(async (sql) => await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${i.values[0]!}::uuid)`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.update({ components: [] });
  await promptAmount(i);
}

/** Ask the amount IN CHAT. */
async function promptAmount(i: ChatInputCommandInteraction | StringSelectMenuInteraction): Promise<void> {
  ses(i.user.id).pending = 'wd_amount';
  await sayChat(i, 'How much do you want to cash out? Just **type the number** here — like `50`.');
}

export async function onAmountText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p || !s.outPlatform) return;
  const amount = parseAmount(text);
  const cfg = (await db()<{ min_amount: number; max_amount: number; amount_step: number }[]>`select min_amount, max_amount, amount_step from config where id`)[0]!;
  if (amount === null) return void (await msg.reply('That doesn\'t look like an amount. Try `50`.'));
  const problem = amountProblem(amount, { min: cfg.min_amount, max: cfg.max_amount, step: cfg.amount_step });
  if (problem) return void (await msg.reply(problem));
  s.outAmount = amount; s.pending = undefined;
  const methods = await payoutMethods();
  if (!methods.length) return void (await msg.reply('No payout methods are available. Please contact us.'));
  await sendChannel(msg, `Cashing out **${whole(amount)}** — how do you want to be paid?`, [selectRow('out:m', 'Choose method', methods.map(methodOption))]);
}

export async function onMethod(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const s = ses(i.user.id);
  s.outMethod = i.values[0]!;
  const [h] = await db()<{ handle: string }[]>`
    select handle from payout_handles where player_id = ${p.id} and method_id = ${s.outMethod}
     order by last_used_at desc nulls last, created_at desc limit 1`;
  if (h) { await i.update({ content: '✅ Using your saved payout details.', components: [] }); return void (await finish(i.user.id, (c) => i.followUp({ content: c, ephemeral: false }).then(() => {}), h.handle)); }
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${s.outMethod}`;
  s.pending = 'wd_handle';
  await i.update({ content: withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + '\n\n**Type it here.**', components: [] });
}

export async function onHandleText(msg: Message, text: string): Promise<void> {
  ses(msg.author.id).pending = undefined;
  await finish(msg.author.id, (c) => sendChannel(msg, c), text);
}

async function finish(userId: string, send: (content: string) => Promise<void>, handle: string): Promise<void> {
  const p = (await currentPlayer(userId))!;
  const s = ses(userId);
  if (!s.outPlatform || !s.outAmount || !s.outMethod) return void (await send('/withdraw again to restart.'));
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${s.outMethod}`;
  if (m?.handle_pattern) {
    let ok = true; try { ok = new RegExp(m.handle_pattern).test(handle); } catch { ok = true; }
    if (!ok) { ses(userId).pending = 'wd_handle'; return void (await send(`That doesn't look right for ${m.name}. Type it again.`)); }
  }
  const platformId = s.outPlatform, methodId = s.outMethod, amount = s.outAmount;
  let w: WithdrawRequest;
  try {
    const rows = await mutate(async (sql) => await sql<WithdrawRequest[]>`select * from withdraw_create(${p.id}::uuid, ${platformId}::uuid, ${methodId}::uuid, ${amount}::bigint, ${handle})`);
    w = rows[0]!;
  } catch (e) {
    if (isUserError(e)) return void (await send(`❌ ${userMessage(e)}`));
    console.error('withdraw_create failed:', e);
    return void (await send('Something went wrong. Nothing was taken from your account. Try again shortly.'));
  }
  const amt = money(w.requested_amount, w.currency);
  await send(cashoutConfirm(m?.code ?? '', m?.name ?? 'payment', w.payout_handle, amt, m?.club_handle) + '\n\nChanged your mind? Cancel it from `/pending` while it\'s still waiting.');
}

/** ✖️ Cancel — retract a cash out (from /pending). */
export async function retract(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return;
  const [w] = await db()<{ status: string }[]>`select status from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w) return void (await i.reply({ ephemeral: true, content: "Can't find that cash out." }));
  if (['completed', 'cancelled'].includes(w.status)) return void (await i.reply({ ephemeral: true, content: `That cash out is already ${w.status}.` }));
  try { await mutate(async (sql) => await sql`select withdraw_cancel(${withdrawId}::uuid, null, 'retracted by player')`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.reply({ ephemeral: false, content: '✅ Cancelled. If any amount was taken from your account, it will be reimbursed.' });
}

/** ➖ Take some back — ask the amount IN CHAT. */
export async function reducePrompt(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const s = ses(i.user.id); s.pending = 'wd_reduce'; s.reduceWd = withdrawId;
  await i.reply({ ephemeral: false, content: 'How much do you want **back** on your table? Type the number (e.g. `20`).' });
}
export async function onReduceText(msg: Message, text: string): Promise<void> {
  const s = ses(msg.author.id); const withdrawId = s.reduceWd; s.pending = undefined; s.reduceWd = undefined;
  if (!withdrawId) return;
  const amount = parseAmount(text);
  if (amount === null) return void (await msg.reply('Send just the number, e.g. `20`.'));
  try { await mutate(async (sql) => await sql`select withdraw_reduce(${withdrawId}::uuid, ${amount}::bigint, null)`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  await msg.reply(`✅ Done — **${money(amount)}** is coming back to your table. The rest is still on its way.`);
}
