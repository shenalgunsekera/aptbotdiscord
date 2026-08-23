import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ButtonInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses } from '../session.js';
import { money, whole, parseAmount, amountProblem, withdrawHandlePrompt, cashoutConfirm } from '../words.js';
import { confirmedPlatforms, payoutMethods, methodOption, say, sayChat, sendChannel, selectRow } from '../flows.js';
import { editDiscordCard } from '../notifier.js';
import { loaderIdentity, loaderIdSelect, loaderIdJoins } from './admin.js';
import type { PaymentMethod, WithdrawRequest } from '../core/index.js';

/** /withdraw — cash-out. platform → club → amount(chat) → method → handle(chat) → queue. */
export async function withdraw(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to set up first.'));
  if (p.status !== 'active') return void (await say(i, "You're almost ready — we just need to confirm your account first."));
  const platforms = await confirmedPlatforms(p.id);
  if (platforms.length === 0) return void (await say(i, "You don't have a confirmed account on any platform yet. `/start` first."));
  if (platforms.length === 1) return void (await afterPlatform(i, platforms[0]!.id));
  await say(i, 'Where do you want to cash-out from?', [selectRow('out:pf', 'Choose platform', platforms.map((pf) => ({ label: pf.name, value: pf.id })))]);
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
  await sayChat(i, 'How much do you want to cash-out? Just **type the number** here — like `50`.');
}

export async function onAmountText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p || !s.outPlatform) return;
  const amount = parseAmount(text);
  // The payout method is chosen after the amount, so use the widest range across
  // enabled payout methods; withdraw_create enforces the chosen method's exact min.
  const cfg = (await db()<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select c.amount_step,
      coalesce((select min(coalesce(m.min_amount, c.min_amount)) from payment_methods m where m.enabled and m.payout_enabled), c.min_amount) as min_amount,
      coalesce((select max(coalesce(m.max_amount, c.max_amount)) from payment_methods m where m.enabled and m.payout_enabled), c.max_amount) as max_amount
      from config c`)[0]!;
  if (amount === null) return void (await msg.reply('That doesn\'t look like an amount. Try `50`.'));
  const problem = amountProblem(amount, { min: cfg.min_amount, max: cfg.max_amount, step: cfg.amount_step });
  if (problem) return void (await msg.reply(problem));
  s.outAmount = amount; s.pending = undefined;

  // Prefer the methods the player has already saved a destination for, so someone
  // with several set up can PICK which one — mirroring the Telegram bot. Each
  // option shows its saved handle; picking one reuses it (see onMethod). None
  // saved → fall back to the full payout-method list to set one up now.
  const saved = await db()<{ id: string; name: string; handle: string }[]>`
    select distinct on (m.id) m.id, m.name,
           first_value(h.handle) over (partition by m.id order by h.last_used_at desc nulls last, h.created_at desc) as handle
      from payout_handles h
      join payment_methods m on m.id = h.method_id
     where h.player_id = ${p.id} and m.enabled and m.payout_enabled
     order by m.id`;
  if (saved.length) {
    const opts = saved.map((sv) => ({ label: sv.name, value: sv.id, description: sv.handle.slice(0, 100) }));
    return void (await sendChannel(msg, `Cashing out **${whole(amount)}** — which payout method?`, [selectRow('out:m', 'Choose method', opts)]));
  }
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
  await send(cashoutConfirm(m?.code ?? '', m?.name ?? 'payment', w.payout_handle, amt, m?.club_handle, m?.settlement, m?.withdraw_payout_mode));
}

type WOut = { id: string; requested_amount: number; amount_remaining: number; currency: string; status: string };
const cancellableOf = (w: WOut) => (w.status === 'pending_unload' ? w.requested_amount : w.amount_remaining);

/** /cancelwithdraw — one → Full/Partial buttons; several → pick which first. */
export async function cancelWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to set up first.'));
  const outs = await db()<WOut[]>`
    select id, requested_amount, amount_remaining, currency, status from withdraw_requests
     where player_id = ${p.id} and status in ('pending_unload','queued','partially_filled')
     order by created_at desc`;
  const live = outs.filter((o) => cancellableOf(o) > 0);
  if (!live.length) return void (await say(i, "You don't have a cash-out to cancel. (Anything already being paid can't be cancelled — use /support if you need help.)"));
  if (live.length === 1) return void (await i.reply({ ephemeral: false, ...cancelOptions(live[0]!) }));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...live.slice(0, 5).map((o) => new ButtonBuilder()
      .setCustomId(`wc:pick:${o.id}`)
      .setLabel(`${money(cancellableOf(o), o.currency)} — ${o.status === 'pending_unload' ? 'not started' : 'in queue'}`)
      .setStyle(ButtonStyle.Secondary)),
  );
  await i.reply({ ephemeral: false, content: 'Which cash-out do you want to cancel?', components: [row] });
}

function cancelOptions(w: WOut): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const c = cancellableOf(w);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wc:full:${w.id}`).setLabel(`Cancel it all (${money(c, w.currency)})`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wc:part:${w.id}`).setLabel('Cancel part of it').setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `Cancel this cash-out? **${money(c, w.currency)}** can be cancelled.` +
      (w.status !== 'pending_unload' ? '\n_An admin will re-load whatever you cancel back onto your table._' : ''),
    components: [row],
  };
}

export async function cancelPick(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const p = await currentPlayer(i.user.id); if (!p) return;
  const [w] = await db()<WOut[]>`select id, requested_amount, amount_remaining, currency, status from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w) return void (await i.update({ content: "Can't find that cash-out.", components: [] }));
  await i.update(cancelOptions(w));
}

export async function cancelFull(i: ButtonInteraction, withdrawId: string): Promise<void> {
  await i.deferUpdate();
  await doCancel(i, withdrawId, Number.MAX_SAFE_INTEGER);
}

export async function cancelPart(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const s = ses(i.user.id); s.pending = 'cancel_amount'; s.cancelWithdrawId = withdrawId;
  await i.update({ content: 'How much do you want to cancel? Type the number here, e.g. `20`.', components: [] });
}

export async function onCancelAmountText(msg: Message, text: string): Promise<void> {
  const s = ses(msg.author.id); const withdrawId = s.cancelWithdrawId;
  s.pending = undefined; s.cancelWithdrawId = undefined;
  if (!withdrawId) return;
  const amount = parseAmount(text);
  if (amount === null || amount <= 0) return void (await msg.reply('Send just the number, e.g. `20`.'));
  await doCancel(msg, withdrawId, amount);
}

/** Shared: run the DB cancel, edit the admin card in place, tell the player. */
async function doCancel(ctx: ButtonInteraction | Message, withdrawId: string, amount: number): Promise<void> {
  const client = ctx.client;
  const reply = async (content: string) => {
    if ('deferUpdate' in ctx) {   // a button interaction (deferred in cancelFull)
      const bi = ctx as ButtonInteraction;
      if (bi.deferred || bi.replied) await bi.editReply({ content, components: [] });
      else await bi.update({ content, components: [] });
    } else {
      await (ctx as Message).reply(content);
    }
  };
  type J = { scenario: string; order_id: string; full: boolean; cancelled: number; new_amount?: number };
  let j: J;
  try {
    const rows = await mutate(async (sql) => await sql<{ j: J }[]>`select withdraw_player_cancel(${withdrawId}::uuid, ${amount}::bigint, null) as j`);
    j = rows[0]!.j;
  } catch (e) {
    if (isUserError(e)) return void (await reply(`❌ ${userMessage(e)}`));
    throw e;
  }

  // A small P2P (or club) cash-out may have a "pay it directly" admin card up. On
  // a FULL cancel it's moot — neutralise it so no admin pays a cancelled one.
  if (j.full) {
    await editDiscordCard(client, 'withdraw_request', withdrawId,
      '🚫 **Cancelled by the player — do not pay.** The chips are being put back on their table.',
      [], 'withdraw.needs_payout').catch(() => {});
  }

  if (j.scenario === 'pending_full') {
    await editDiscordCard(client, 'loader_order', j.order_id, '↩️ **Cash-out cancelled by the player** — nothing to take off.');
    return void (await reply('✅ Your cash-out was cancelled. Nothing was taken off your table.'));
  }
  if (j.scenario === 'pending_partial') {
    const [o] = await db()<{ delta: number; currency: string; account: string; platform: string | null; platform_uid: string; club: string | null }[]>`
      select o.delta, o.currency, ${loaderIdSelect()} from loader_orders o ${loaderIdJoins()} where o.id = ${j.order_id}`;
    if (o) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`lo:claim:${j.order_id}`).setLabel('✋ Claim').setStyle(ButtonStyle.Primary));
      await editDiscordCard(client, 'loader_order', j.order_id,
        `🎰 **TAKE OFF ${money(Math.abs(Number(o.delta)), o.currency)}** (reduced by the player)\n` +
          loaderIdentity(o), [row]);
    }
    // Be explicit: <cancelled> comes back to the table, <new_amount> is the new
    // cash-out total. If that total sits at the minimum, say why it can't go lower.
    const cur = o?.currency ?? 'USD';
    const cfgRow = await db()<{ min_amount: number }[]>`select min_amount from config where id`;
    const min_amount = cfgRow[0]?.min_amount ?? 0;
    const atMin = min_amount > 0 && Number(j.new_amount ?? 0) <= Number(min_amount);
    const note = atMin ? ` — that's the ${money(min_amount, cur)} minimum, so it can't go lower without cancelling it all` : '';
    return void (await reply(
      `✅ **${money(Number(j.cancelled ?? 0), cur)}** is coming back to your table. Your cash-out is now **${money(Number(j.new_amount ?? 0), cur)}**${note}. Your spot in line stays.`));
  }
  await reply(
    `✅ Cancellation requested. An admin will re-load **${money(Number(j.cancelled))}** back onto your table — ` +
      `you'll get a confirmation here the moment it's back.` + (j.full ? '' : '\n_The rest stays in your queue._'));
}

// ─── /addtowithdraw — add to an existing, queued cash-out ────────────────────
/**
 * Increase a cash-out already waiting in the queue WITHOUT losing the player's
 * place in line. The extra is taken off the tables by a loader (the same "TAKE
 * OFF" card admins already work) and escrowed onto the SAME cash-out row, so the
 * queue spot is kept. Mirrors the Telegram bot. See withdraw_topup (0077).
 */
// A live cash-out + how much is ALREADY PAID (released fills). What's still owed
// is (amount - paid) — the number an add-on grows.
type TOut = { id: string; amount: number | null; paid: number; currency: string; method: string };

export async function addToWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await say(i, 'Send `/start` to set up first.'));
  const outs = await db()<TOut[]>`
    select w.id, w.amount, w.currency, pm.name as method,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = w.id and f.status = 'released'), 0) as paid
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.player_id = ${p.id} and w.status in ('queued','partially_filled')
       and w.cancel_requested_at is null
     order by w.created_at desc`;
  if (!outs.length) {
    return void (await say(i, "You don't have a cash-out in the queue to add to. Start one with `/withdraw` (you can add to it once it's waiting to be paid)."));
  }
  if (outs.length === 1) return void (await promptTopupAmount(i, outs[0]!));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...outs.slice(0, 5).map((o) => {
      const total = Number(o.amount ?? 0), paid = Number(o.paid);
      return new ButtonBuilder()
        .setCustomId(`wt:pick:${o.id}`)
        .setLabel(paid > 0
          ? `${money(total, o.currency)} via ${o.method} (${money(total - paid, o.currency)} still to pay)`
          : `${money(total, o.currency)} via ${o.method}`)
        .setStyle(ButtonStyle.Secondary);
    }),
  );
  await i.reply({ ephemeral: false, content: 'Which cash-out do you want to add to?', components: [row] });
}

async function promptTopupAmount(
  i: ChatInputCommandInteraction | ButtonInteraction, w: TOut,
): Promise<void> {
  const s = ses(i.user.id); s.pending = 'wd_topup_amount'; s.topupWithdrawId = w.id;
  // Accurate about a partially-PAID cash-out: paid (released) vs. still owed.
  const total = Number(w.amount ?? 0);
  const paid = Number(w.paid);
  const toPay = total - paid;
  const state = paid > 0
    ? `You have **${money(toPay, w.currency)}** still to be paid on your ${w.method} cash-out ` +
      `(**${money(paid, w.currency)}** of the **${money(total, w.currency)}** is already paid).`
    : `Your ${w.method} cash-out is currently **${money(total, w.currency)}**, all still to be paid.`;
  const body = `${state}\n\n` +
    `How much do you want to **add**? Just **type the number** here, like \`20\` — it's added on top of what's still owed ` +
    `(so ${money(toPay, w.currency)} + $20 = ${money(toPay + 2000, w.currency)} still to pay). ` +
    `We take it off your table and add it to this same cash-out, so you keep your place in line.`;
  if (i.isButton()) await i.update({ content: body, components: [] });
  else await say(i, body);
}

export async function topupPick(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const p = await currentPlayer(i.user.id); if (!p) return;
  const [w] = await db()<TOut[]>`
    select w.id, w.amount, w.currency, pm.name as method,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = w.id and f.status = 'released'), 0) as paid
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.id = ${withdrawId} and w.player_id = ${p.id}
       and w.status in ('queued','partially_filled') and w.cancel_requested_at is null`;
  if (!w) return void (await i.update({ content: 'That cash-out can no longer be added to.', components: [] }));
  await promptTopupAmount(i, w);
}

export async function onTopupAmountText(msg: Message, text: string): Promise<void> {
  const s = ses(msg.author.id); const withdrawId = s.topupWithdrawId;
  s.pending = undefined; s.topupWithdrawId = undefined;
  if (!withdrawId) return;
  const amount = parseAmount(text);
  if (amount === null || amount <= 0) return void (await msg.reply('That doesn\'t look like an amount. Try `20`.'));
  const cfg = (await db()<{ amount_step: number }[]>`select amount_step from config where id`)[0]!;
  if (cfg.amount_step > 0 && amount % cfg.amount_step !== 0) {
    return void (await msg.reply(`Please add in whole multiples of ${whole(cfg.amount_step)} — no cents.`));
  }
  try {
    // The DB does the full check (still queued, not cancelling, one add-on at a
    // time, method cap, daily cap) and raises the extra take-off card for admins.
    await mutate(async (sql) => await sql`select withdraw_topup(${withdrawId}::uuid, ${amount}::bigint)`);
  } catch (e) {
    if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`));
    console.error('withdraw_topup failed:', e);
    return void (await msg.reply('Something went wrong. Nothing was taken from your account. Try again shortly.'));
  }
  await msg.reply(
    `✅ **Got it — adding ${money(amount)} to your cash-out.**\n` +
      `We're taking that much more off your table now. It joins this same cash-out, so you ` +
      `**keep your place in line** — you'll just be paid the larger amount.`,
  );
}

/** ✖️ Cancel — retract a cash-out (from /pending). */
export async function retract(i: ButtonInteraction, withdrawId: string): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return;
  const [w] = await db()<{ status: string }[]>`select status from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w) return void (await i.reply({ ephemeral: true, content: "Can't find that cash-out." }));
  if (['completed', 'cancelled'].includes(w.status)) return void (await i.reply({ ephemeral: true, content: `That cash-out is already ${w.status}.` }));
  try { await mutate(async (sql) => await sql`select withdraw_cancel(${withdrawId}::uuid, null, 'retracted by player')`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  // Neutralise any "pay it directly" admin card — this cash-out is cancelled.
  await editDiscordCard(i.client, 'withdraw_request', withdrawId,
    '🚫 **Cancelled by the player — do not pay.** Anything that came off their table is being put back.',
    [], 'withdraw.needs_payout').catch(() => {});
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
