import {
  ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { currentPlayer } from '../identity.js';
import { ses } from '../session.js';
import { say } from '../flows.js';
import type { Player } from '../core/index.js';

type Opt = { label: string; value: string; default?: boolean };
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
  const methods = await db()<{ id: string; name: string }[]>`select id, name from payment_methods where enabled order by sort_order, name`;
  const cur = new Set((await db()<{ method_id: string }[]>`select method_id from player_method_prefs where player_id = ${p.id}`).map((r) => r.method_id));
  await i.reply({ ephemeral: true, content: 'Pick the payment methods you want to **deposit** with:',
    components: [menu('ed:methods', 'Deposit methods', methods.map((m) => ({ label: m.name, value: m.id, default: cur.has(m.id) })))] });
}
export async function onMethods(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${db().array(i.values)}::uuid[])`);
  await i.update({ content: '✅ Saved your deposit methods.', components: [] });
}

// ── /editwithdraw — how you get paid ──
export async function editWithdraw(i: ChatInputCommandInteraction): Promise<void> {
  if (!(await player(i))) return;
  const methods = await db()<{ id: string; name: string }[]>`select id, name from payment_methods where enabled and payout_enabled order by sort_order, name`;
  await i.reply({ ephemeral: true, content: 'How do you want to **get paid** when you cash out?',
    components: [menu('ed:payoutm', 'Payout method', methods.map((m) => ({ label: m.name, value: m.id })), 1, 1)] });
}
export async function onPayoutMethod(i: StringSelectMenuInteraction): Promise<void> {
  ses(i.user.id).outMethod = i.values[0]!;
  const [m] = await db()<{ name: string }[]>`select name from payment_methods where id = ${i.values[0]!}`;
  await i.showModal(new ModalBuilder().setCustomId('ed:payouth').setTitle(`Your ${m?.name ?? 'payout'} details`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('handle').setLabel('Where should we pay you?').setStyle(TextInputStyle.Short).setRequired(true))));
}
export async function onPayoutHandle(i: ModalSubmitInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const methodId = ses(i.user.id).outMethod!;
  const handle = i.fields.getTextInputValue('handle').trim();
  await mutate(async (sql) => await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${handle})`);
  await i.reply({ ephemeral: true, content: '✅ Saved how you get paid.' });
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
  if (plats.length === 1) return void (await i.reply({ ephemeral: true, content: `Which **${plats[0]!.name}** club(s) are you in?`, components: [await clubMenu(p.id, plats[0]!.id)] }));
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
  await i.update({ content: 'Pick your club(s):', components: [await clubMenu(p.id, i.values[0]!)] });
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
  await i.reply({ ephemeral: true, content: 'Tick the platforms you play on. Unticking one removes it; ticking a new one adds it.',
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
    const chosen = await db()<{ id: string; code: string; name: string }[]>`select id, code, name from platforms where id = any(${db().array(added)}::uuid[]) order by sort_order`;
    const modal = new ModalBuilder().setCustomId('ed:pfaccounts').setTitle('New account details');
    for (const pf of chosen.slice(0, 5)) {
      const label = pf.code === 'clubgg' ? 'ClubGG ID' : pf.code === 'sportsbook' ? 'Sportsbook username' : `${pf.name} account ID`;
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(pf.id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true)));
    }
    return void (await i.showModal(modal));
  }
  await i.update({ content: doneMsg([], blocked), components: [] });
}
export async function onPfAccounts(i: ModalSubmitInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const added = ses(i.user.id).editAddPlatforms ?? [];
  const names: string[] = [];
  try {
    for (const pid of added) {
      const uid = i.fields.getTextInputValue(pid)?.trim();
      if (uid) { await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${uid})`); const [pf] = await db()<{ name: string }[]>`select name from platforms where id = ${pid}`; if (pf) names.push(pf.name); }
    }
  } catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.reply({ ephemeral: true, content: doneMsg(names, ses(i.user.id).editBlocked ?? []) });
}
function doneMsg(added: string[], blocked: string[]): string {
  const parts: string[] = [];
  if (added.length) parts.push(`✅ Added **${added.join(', ')}** — an admin will confirm shortly.`);
  if (!added.length) parts.push('✅ Your platforms are updated.');
  if (blocked.length) parts.push(`⚠️ Couldn't remove: ${blocked.join('; ')}`);
  return parts.join('\n');
}
