import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { registerPlayer, currentPlayer } from '../identity.js';
import { ses, clearSes } from '../session.js';
import { say, selectRow, depositMethods } from '../flows.js';
import type { Player, Platform } from '../core/index.js';

/** /start — begin or resume setup. Chain: name → platforms → accounts → clubs →
 *  deposit methods → payout. Text via modals, choices via select menus. */
export async function start(i: ChatInputCommandInteraction): Promise<void> {
  const p = await registerPlayer(i.user.id, i.user.username, i.channelId);
  if (!p.display_name?.trim()) return void (await i.showModal(nameModal()));
  await i.reply({ ephemeral: true, embeds: [summary(p.display_name)] });
  await askPlatforms(i);
}

function nameModal(): ModalBuilder {
  return new ModalBuilder().setCustomId('ob:name').setTitle('Welcome! What should we call you?')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Your name').setPlaceholder('The name you go by')
        .setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(40).setRequired(true)));
}

export async function onName(i: ModalSubmitInteraction): Promise<void> {
  const name = i.fields.getTextInputValue('name').trim();
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await i.reply({ ephemeral: true, content: 'Send /start to begin.' }));
  try { await mutate(async (sql) => await sql`select player_set_name(${p.id}::uuid, ${name})`); }
  catch (e) { if (isUserError(e)) return void (await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await i.reply({ ephemeral: true, content: `👋 Nice to meet you, **${name}**.` });
  await askPlatforms(i);
}

async function askPlatforms(i: ChatInputCommandInteraction | ModalSubmitInteraction): Promise<void> {
  const platforms = await db()<Platform[]>`select * from platforms where enabled order by sort_order`;
  await i.followUp({ ephemeral: true, content: 'Where do you play? Pick all that apply, then submit.',
    components: [selectRow('ob:platforms', 'Choose platform(s)', platforms.map((pf) => ({ label: pf.name, value: pf.id })), { min: 1, max: platforms.length })] });
}

/** Platforms chosen → collect the account id(s) in one modal. */
export async function onPlatforms(i: StringSelectMenuInteraction): Promise<void> {
  ses(i.user.id).platforms = i.values;
  const chosen = await db()<Platform[]>`select * from platforms where id = any(${db().array(i.values)}::uuid[]) order by sort_order`;
  const modal = new ModalBuilder().setCustomId('ob:accounts').setTitle('Your account details');
  for (const pf of chosen.slice(0, 5)) {
    const label = pf.code === 'clubgg' ? 'ClubGG ID' : pf.code === 'sportsbook' ? 'Sportsbook username' : `${pf.name} account ID`;
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(pf.id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true)));
  }
  await i.showModal(modal);
}

export async function onAccounts(i: ModalSubmitInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) return void (await i.reply({ ephemeral: true, content: 'Send /start to begin.' }));
  const platformIds = ses(i.user.id).platforms ?? [];
  await i.reply({ ephemeral: true, content: '✅ Got your account details — an admin will confirm them shortly.' });
  try {
    for (const pid of platformIds) {
      const uid = i.fields.getTextInputValue(pid)?.trim();
      if (uid) await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${uid})`);
    }
  } catch (e) { if (isUserError(e)) return void (await i.followUp({ ephemeral: true, content: `❌ ${userMessage(e)}` })); throw e; }
  await askClubsOrMethods(i, p.id);
}

/** Show a club picker for the next platform that has more than one club; else methods. */
async function askClubsOrMethods(i: ModalSubmitInteraction | StringSelectMenuInteraction, playerId: string): Promise<void> {
  const next = await db()<{ id: string; name: string }[]>`
    select pf.id, pf.name from platforms pf
      join player_platforms pp on pp.platform_id = pf.id
     where pp.player_id = ${playerId} and pp.active
       and (select count(*) from clubs c where c.platform_id = pf.id and c.enabled) > 1
       and not exists (select 1 from player_clubs pc join clubs c on c.id = pc.club_id where pc.player_id = ${playerId} and c.platform_id = pf.id)
     order by pf.sort_order limit 1`;
  if (!next.length) {
    // Auto-join single-club platforms, then move on to deposit methods.
    await mutate(async (sql) => {
      const singles = await sql<{ platform_id: string; club_id: string }[]>`
        select pf.id platform_id, (select c.id from clubs c where c.platform_id = pf.id and c.enabled limit 1) club_id
          from platforms pf join player_platforms pp on pp.platform_id = pf.id
         where pp.player_id = ${playerId} and pp.active
           and (select count(*) from clubs c where c.platform_id = pf.id and c.enabled) = 1
           and not exists (select 1 from player_clubs pc join clubs c on c.id = pc.club_id where pc.player_id = ${playerId} and c.platform_id = pf.id)`;
      for (const s of singles) await sql`select player_set_clubs(${playerId}::uuid, ${s.platform_id}::uuid, array[${s.club_id}]::uuid[])`;
    });
    return void (await askMethods(i, playerId));
  }
  const clubs = await db()<{ id: string; name: string }[]>`select id, name from clubs where platform_id = ${next[0]!.id} and enabled order by name`;
  await i.followUp({ ephemeral: true, content: `Which **${next[0]!.name}** club(s) do you play in?`,
    components: [selectRow(`ob:clubs:${next[0]!.id}`, 'Choose club(s)', clubs.map((c) => ({ label: c.name, value: c.id })), { min: 1, max: clubs.length })] });
}

export async function onClubs(i: StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select player_set_clubs(${p.id}::uuid, ${platformId}::uuid, ${db().array(i.values)}::uuid[])`);
  await i.update({ content: '✅ Club(s) saved.', components: [] });
  await askClubsOrMethods(i, p.id);
}

async function askMethods(i: ModalSubmitInteraction | StringSelectMenuInteraction, playerId: string): Promise<void> {
  const methods = await db()<{ id: string; name: string }[]>`select id, name from payment_methods where enabled order by sort_order, name`;
  await i.followUp({ ephemeral: true, content: 'How do you want to **deposit**? Pick all you might use.',
    components: [selectRow('ob:methods', 'Deposit methods', methods.map((m) => ({ label: m.name, value: m.id })), { min: 1, max: Math.min(25, methods.length) })] });
}

export async function onMethods(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${db().array(i.values)}::uuid[])`);
  const payout = await db()<{ id: string; name: string }[]>`select id, name from payment_methods where enabled and payout_enabled order by sort_order, name`;
  await i.update({ content: '✅ Deposit methods saved. Last step — how do you want to **get paid** when you cash out?',
    components: [selectRow('ob:payoutm', 'Payout method', payout.map((m) => ({ label: m.name, value: m.id })))] });
}

export async function onPayoutMethod(i: StringSelectMenuInteraction): Promise<void> {
  ses(i.user.id).outMethod = i.values[0]!;
  const [m] = await db()<{ code: string; name: string }[]>`select code, name from payment_methods where id = ${i.values[0]!}`;
  await i.showModal(new ModalBuilder().setCustomId('ob:payouth').setTitle(`Your ${m?.name ?? 'payout'} details`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('handle').setLabel('Where should we pay you?').setStyle(TextInputStyle.Short).setRequired(true))));
}

export async function onPayoutHandle(i: ModalSubmitInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  const methodId = ses(i.user.id).outMethod!;
  const handle = i.fields.getTextInputValue('handle').trim();
  await mutate(async (sql) => {
    await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${handle})`;
  });
  clearSes(i.user.id);
  await i.reply({ ephemeral: true, content: '🎉 **All set!** An admin will confirm your account(s) shortly, then you can `/deposit` and `/withdraw`. See `/guide` anytime.' });
}

function summary(name: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(`You're all set, ${name}`)
    .setDescription('💵 `/deposit` — add money\n💸 `/withdraw` — cash out\n📋 `/pending` — your account\n📖 `/guide` — what each command does');
}
