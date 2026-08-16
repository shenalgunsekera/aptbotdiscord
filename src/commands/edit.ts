import {
  ActionRowBuilder, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type Message,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses } from '../session.js';
import { say, sayChat, sendChannel, allMethods, payoutMethods, methodOption } from '../flows.js';
import { withdrawHandlePrompt } from '../words.js';
import { validClubggId, clubggIdError } from './start.js';
import type { Player } from '../core/index.js';

type Opt = { label: string; value: string; description?: string; default?: boolean };
function menu(customId: string, placeholder: string, options: Opt[], min = 1, max?: number) {
  const m = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
    .setMinValues(min).setMaxValues(max ?? options.length).addOptions(options.slice(0, 25));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(m);
}
async function player(i: ChatInputCommandInteraction): Promise<Player | null> {
  const p = await currentPlayer(i.user.id);
  if (!p) { await say(i, 'Send `/start` to set up first.'); return null; }
  return p;
}

// ── /editdeposit — which methods you deposit with ──
export async function editDeposit(i: ChatInputCommandInteraction): Promise<void> {
  const p = await player(i); if (!p) return;
  const methods = await allMethods();
  const cur = new Set((await db()<{ method_id: string }[]>`select method_id from player_method_prefs where player_id = ${p.id}`).map((r) => r.method_id));
  await i.reply({ ephemeral: true, content: 'Which methods do you want to use to deposit? Tap all that apply, then Done.',
    components: [menu('ed:methods', 'Deposit methods', methods.map((m) => ({ ...methodOption(m), default: cur.has(m.id) })))] });
}
export async function onMethods(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${db().array(i.values)}::uuid[])`);
  await i.update({ content: '✅ Saved your deposit methods.', components: [] });
}

// ── /editwithdraw — how you get paid. You can save SEVERAL methods (each with
//    its own handle) — run this once per method and pick which to use at cash-out.
async function savedPayouts(playerId: string): Promise<{ name: string; handle: string }[]> {
  return db()<{ name: string; handle: string }[]>`
    select distinct on (m.id) m.name,
           first_value(h.handle) over (partition by m.id order by h.last_used_at desc nulls last, h.created_at desc) as handle
      from payout_handles h join payment_methods m on m.id = h.method_id
     where h.player_id = ${playerId} and m.enabled and m.payout_enabled order by m.id`;
}
export async function editWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  const p = await player(i); if (!p) return;
  const methods = await payoutMethods();
  const saved = await savedPayouts(p.id);
  const current = saved.length ? `**Saved:** ${saved.map((s) => `${s.name} — \`${s.handle}\``).join(', ')}\n\n` : '';
  // Multi-select + per-method handle collection, exactly like Telegram.
  await i.reply({ ephemeral: true, content: `${current}Which methods do you want to use to withdraw? Tap all that apply, then Done.`,
    components: [menu('ed:payoutm', 'Payout methods', methods.map(methodOption), 1, Math.min(25, methods.length))] });
}
export async function onPayoutMethod(i: StringSelectMenuInteraction): Promise<void> {
  const s = ses(i.user.id);
  s.wdQueue = [...i.values];
  const first = s.wdQueue.shift()!;
  s.outMethod = first;
  s.pending = 'edit_payout';
  const [m] = await db()<{ code: string; name: string; club_handle: string | null }[]>`
    select code, name, club_handle from payment_methods where id = ${first}`;
  const more = s.wdQueue.length ? `\n\n_(${s.wdQueue.length} more after this)_` : '';
  await i.update({ content: withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + more, components: [] });
}

/** Next chosen payout method, or finish the edit. */
async function askNextEditPayout(msg: Message): Promise<void> {
  const s = ses(msg.author.id);
  const p = (await currentPlayer(msg.author.id))!;
  s.wdQueue = s.wdQueue ?? [];
  const next = s.wdQueue.shift();
  if (!next) {
    s.pending = undefined; s.outMethod = undefined; s.payoutHandle = undefined;
    const saved = await savedPayouts(p.id);
    await sendChannel(msg, `✅ Updated how you get paid. **Your payout methods:** ${saved.map((sv) => `${sv.name} — \`${sv.handle}\``).join(', ')}`);
    return;
  }
  s.outMethod = next;
  s.pending = 'edit_payout';
  const [m] = await db()<{ code: string; name: string; club_handle: string | null }[]>`
    select code, name, club_handle from payment_methods where id = ${next}`;
  const more = s.wdQueue.length ? `\n\n_(${s.wdQueue.length} more after this)_` : '';
  await sendChannel(msg, withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + more);
}

export async function payoutHandleText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return;
  if (!s.outMethod) return void (await msg.reply('That step expired — run `/editwithdraw` again.'));
  const methodId = s.outMethod;
  await mutate(async (sql) => await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${text})`);
  const [m] = await db()<{ code: string }[]>`select code from payment_methods where id = ${methodId}`;
  if (m?.code === 'zelle') {
    s.pending = 'edit_payout_name'; s.payoutHandle = text.trim();
    return void (await msg.reply('✅ Saved your **Zelle**. What is the first and last name associated with that Zelle account?'));
  }
  await msg.reply(`✅ Saved — \`${text.trim()}\`.`);
  await askNextEditPayout(msg);
}

export async function payoutNameText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p || !s.outMethod || !s.payoutHandle) return void (await msg.reply('That step expired — run `/editwithdraw` again.'));
  await mutate(async (sql) => await sql`select payout_handle_remember(${p.id}::uuid, ${s.outMethod!}::uuid, ${s.payoutHandle!}, null, ${text})`);
  await msg.reply(`✅ Zelle name saved (**${text.trim()}**).`);
  await askNextEditPayout(msg);
}

// ── /editclubs — which clubs you play in ──
export async function editClubs(i: ChatInputCommandInteraction): Promise<void> {
  const p = await player(i); if (!p) return;
  const plats = await db()<{ id: string; name: string }[]>`
    select pf.id, pf.name from platforms pf join player_platforms pp on pp.platform_id = pf.id
     where pp.player_id = ${p.id} and pp.active and pp.platform_uid is not null
       and (select count(*) from clubs c where c.platform_id = pf.id and c.enabled) > 1
     order by pf.sort_order`;
  if (!plats.length) return void (await i.reply({ ephemeral: true, content: "There aren't any other clubs to switch between right now." }));
  if (plats.length === 1) return void (await i.reply({ ephemeral: true, content: `Which **${plats[0]!.name}** club(s) will you be using? Tap all that apply, then Done.`, components: [await clubMenu(p.id, plats[0]!.id)] }));
  await i.reply({ ephemeral: true, content: "Which platform's clubs do you want to edit?",
    components: [menu('ed:clubpf', 'Choose platform', plats.map((pf) => ({ label: pf.name, value: pf.id })), 1, 1)] });
}
async function clubMenu(playerId: string, platformId: string) {
  const clubs = await db()<{ id: string; name: string }[]>`select id, name from clubs where platform_id = ${platformId} and enabled order by name`;
  const mine = new Set((await db()<{ club_id: string }[]>`select pc.club_id from player_clubs pc join clubs c on c.id = pc.club_id where pc.player_id = ${playerId} and c.platform_id = ${platformId}`).map((r) => r.club_id));
  return menu(`ed:clubs:${platformId}`, 'Choose club(s)', clubs.map((c) => ({ label: c.name, value: c.id, default: mine.has(c.id) })));
}
export async function onClubPlatform(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await i.update({ content: 'Which club(s) will you be using? Tap all that apply, then Done.', components: [await clubMenu(p.id, i.values[0]!)] });
}
export async function onClubs(i: StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select player_set_clubs(${p.id}::uuid, ${platformId}::uuid, ${db().array(i.values)}::uuid[])`);
  await i.update({ content: '✅ Saved which clubs you play in.', components: [] });
}

// ── /editplatform — add or remove ClubGG / Sportsbook ──
export async function editPlatform(i: ChatInputCommandInteraction): Promise<void> {
  const p = await player(i); if (!p) return;
  const platforms = await db()<{ id: string; name: string }[]>`select id, name from platforms where enabled order by sort_order`;
  const active = new Set((await db()<{ platform_id: string }[]>`select platform_id from player_platforms where player_id = ${p.id} and active`).map((r) => r.platform_id));
  await i.reply({ ephemeral: true, content: 'Which platform(s) will you be using? Tap all that apply, then Done.',
    components: [menu('ed:platforms', 'Your platforms', platforms.map((pf) => ({ label: pf.name, value: pf.id, default: active.has(pf.id) })), 1)] });
}
export async function onPlatforms(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const selected = new Set(i.values);
  const rows = await db()<{ platform_id: string; active: boolean }[]>`select platform_id, active from player_platforms where player_id = ${p.id}`;
  const active = new Set(rows.filter((r) => r.active).map((r) => r.platform_id));
  const blocked: string[] = [];
  // Remove unticked (soft-unlink; guarded against open activity).
  for (const pid of active) {
    if (selected.has(pid)) continue;
    try { await mutate(async (sql) => await sql`select player_unlink_platform(${p.id}::uuid, ${pid}::uuid)`); }
    catch (e) { const [pf] = await db()<{ name: string }[]>`select name from platforms where id = ${pid}`; blocked.push(`${pf?.name}: ${isUserError(e) ? userMessage(e) : 'in use'}`); }
  }
  // Reactivate any ticked platform that already has an account row.
  const added: string[] = [];
  for (const pid of selected) {
    const row = rows.find((r) => r.platform_id === pid);
    if (row && !row.active) await mutate(async (sql) => await sql`update player_platforms set active = true where player_id = ${p.id} and platform_id = ${pid}`);
    else if (!row) added.push(pid);
  }
  ses(i.user.id).editBlocked = blocked;
  if (added.length) {
    ses(i.user.id).editAddPlatforms = added;
    ses(i.user.id).pending = 'edit_acct';
    await i.update({ content: '✅ Updating your platforms…', components: [] });
    await askNextEditAccount((c) => i.followUp({ content: c, ephemeral: false }).then(() => {}), i.user.id);
    return;
  }
  await i.update({ content: doneMsg(blocked), components: [] });
}

/** Ask the next added platform's account id IN CHAT, or finish. */
async function askNextEditAccount(send: (content: string) => Promise<void>, userId: string): Promise<void> {
  const s = ses(userId);
  const queue = s.editAddPlatforms ?? [];
  if (!queue.length) { s.pending = undefined; await send('✅ Added — an admin will confirm shortly. ' + doneMsg(s.editBlocked ?? [])); return; }
  const [pf] = await db()<{ code: string; name: string }[]>`select code, name from platforms where id = ${queue[0]!}`;
  const label = pf?.code === 'clubgg' ? 'ClubGG ID' : pf?.code === 'sportsbook' ? 'Sportsbook username' : `${pf?.name} account ID`;
  const eg = pf?.code === 'clubgg' ? '\n_The 8-digit player ID (e.g. 1234-5678) — NOT the 6-digit club code._' : '';
  await send(`What's your **${label}**?${eg}`);
}

export async function acctText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return; const pid = (s.editAddPlatforms ?? [])[0]; if (!pid) return;
  const [pf] = await db()<{ code: string }[]>`select code from platforms where id = ${pid}`;
  if (pf?.code === 'clubgg') {
    const uid = validClubggId(text);
    if (!uid) return void (await msg.reply(clubggIdError(text)));   // stays on 'acct', so their next message retries
    s.pending = 'edit_clubgg_user'; s.clubggUid = uid;
    await msg.reply("What's your **ClubGG username**?");
    return;
  }
  try { await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${text})`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  s.editAddPlatforms = (s.editAddPlatforms ?? []).slice(1);
  await askNextEditAccount((c) => sendChannel(msg, c), msg.author.id);
}

export async function clubggUserText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return; const pid = (s.editAddPlatforms ?? [])[0]; if (!pid || !s.clubggUid) return;
  try { await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${s.clubggUid!}, ${text.trim()})`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  s.clubggUid = undefined; s.pending = undefined;
  s.editAddPlatforms = (s.editAddPlatforms ?? []).slice(1);
  await askNextEditAccount((c) => sendChannel(msg, c), msg.author.id);
}

function doneMsg(blocked: string[]): string {
  return blocked.length ? `⚠️ Couldn't remove: ${blocked.join('; ')}` : '✅ Your platforms are updated.';
}
