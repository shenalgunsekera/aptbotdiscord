import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ButtonInteraction,
  type Message, type RepliableInteraction,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { registerPlayer, currentPlayer } from '../identity.js';
import { ses, clearSes } from '../session.js';
import { selectRow, allMethods, payoutMethods, methodOption, sendChannel } from '../flows.js';
import { withdrawHandlePrompt, COMMANDS_LIST, SETUP_COMPLETE, DEV_NOTICE } from '../words.js';
import type { Platform } from '../core/index.js';

/** Everything is collected in CHAT — no popup forms. Selects (dropdowns) stay,
 *  since they're inline, not forms. A `Sender` posts a prompt whether we're
 *  coming from an interaction or a typed message. */
type Sender = (content: string, components?: any[]) => Promise<void>;
const fromInteraction = (i: RepliableInteraction): Sender => async (content, components = []) => {
  if (i.replied || i.deferred) await i.followUp({ content, components, ephemeral: false });
  else await i.reply({ content, components, ephemeral: false });
};
const fromMessage = (msg: Message): Sender => (content, components = []) => sendChannel(msg, content, components);

export async function start(i: ChatInputCommandInteraction): Promise<void> {
  const p = await registerPlayer(i.user.id, i.user.username, i.channelId);
  const s = ses(i.user.id);
  if (!p.display_name?.trim()) { s.pending = 'name'; await i.reply({ ephemeral: false, content: "👋 Welcome! First — **what's your name?** Just type it here." }); return; }
  await i.reply({ ephemeral: true, embeds: [summary(p.display_name)] });
  await askPlatforms(fromInteraction(i));
}

export async function nameText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); if (!p) return;
  try { await mutate(async (sql) => await sql`select player_set_name(${p.id}::uuid, ${text})`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  ses(msg.author.id).pending = undefined;
  await msg.reply(`👋 Nice to meet you, **${text}**.`);
  await askPlatforms(fromMessage(msg));
}

async function askPlatforms(send: Sender): Promise<void> {
  const platforms = await db()<Platform[]>`select * from platforms where enabled order by sort_order`;
  await send('Which platform(s) will you be using? Tap all that apply, then Done.',
    [selectRow('ob:platforms', 'Choose platform(s)', platforms.map((pf) => ({ label: pf.name, value: pf.id })), { min: 1, max: platforms.length })]);
}

export async function onPlatforms(i: StringSelectMenuInteraction): Promise<void> {
  ses(i.user.id).platforms = i.values;
  const chosen = await db()<Platform[]>`select * from platforms where id = any(${db().array(i.values)}::uuid[]) order by sort_order`;
  if (chosen.some((pf) => pf.code === 'sportsbook')) {
    return void (await i.update({ content: 'Do you already have an **APT Sports** account?',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('ob:sbyes').setLabel('✅ Yes, I have one').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ob:sbno').setLabel('🆕 No, make me one').setStyle(ButtonStyle.Primary))] }));
  }
  await i.update({ content: '✅ Got it.', components: [] });
  beginAccounts(i.user.id, false);
  await askNextAccount(fromInteraction(i), i.user.id);
}

export async function onSbHas(i: ButtonInteraction, has: boolean): Promise<void> {
  await i.update({ content: has ? '✅ Great.' : "🆕 No problem — we'll make one for you.", components: [] });
  beginAccounts(i.user.id, !has);
  await askNextAccount(fromInteraction(i), i.user.id);
}

function beginAccounts(userId: string, sbCreate: boolean): void {
  const s = ses(userId);
  s.acctQueue = [...(s.platforms ?? [])];
  s.sbCreate = sbCreate;
}

/** Ask for the next platform's account id in chat, or move on to clubs. */
async function askNextAccount(send: Sender, userId: string): Promise<void> {
  const s = ses(userId);
  const queue = s.acctQueue ?? [];
  if (!queue.length) {
    s.pending = undefined;
    const p = await currentPlayer(userId);
    if (p) await askClubsOrMethods(send, p.id);
    return;
  }
  const [pf] = await db()<Platform[]>`select * from platforms where id = ${queue[0]!}`;
  if (pf?.code === 'sportsbook' && s.sbCreate) { s.pending = 'sb_user'; await send('What would you like your **username** to be? (Max 10 characters)'); return; }
  s.pending = 'acct';
  const label = pf?.code === 'clubgg' ? 'ClubGG ID' : pf?.code === 'sportsbook' ? 'APT Sports username' : `${pf?.name} account ID`;
  const eg = pf?.code === 'clubgg' ? '\n(e.g. 1234-5678)' : '';
  await send(`What's your **${label}**?${eg}`);
}

export async function acctText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return; const pid = (s.acctQueue ?? [])[0]; if (!pid) return;
  const [pf] = await db()<{ code: string }[]>`select code from platforms where id = ${pid}`;
  if (pf?.code === 'clubgg') {
    // ClubGG: we have the ID, now ask the username; claim with both next.
    s.pending = 'clubgg_user'; s.clubggUid = text.trim();
    await msg.reply("What's your **ClubGG username**?");
    return;
  }
  try { await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${text})`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  s.acctQueue = (s.acctQueue ?? []).slice(1);
  await askNextAccount(fromMessage(msg), msg.author.id);
}

export async function clubggUserText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return; const pid = (s.acctQueue ?? [])[0]; if (!pid || !s.clubggUid) return;
  try { await mutate(async (sql) => await sql`select player_claim_platform(${p.id}::uuid, ${pid}::uuid, ${s.clubggUid!}, ${text.trim()})`); }
  catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
  s.clubggUid = undefined; s.pending = undefined;
  s.acctQueue = (s.acctQueue ?? []).slice(1);
  await askNextAccount(fromMessage(msg), msg.author.id);
}

export async function sbUserText(msg: Message, text: string): Promise<void> {
  const s = ses(msg.author.id); s.sbUser = text; s.pending = 'sb_pass';
  await msg.reply('What would you like your **password** to be? (Max 10 characters)');
}
export async function sbPassText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p) return;
  const pid = (s.acctQueue ?? [])[0]; const user = s.sbUser;
  if (pid && user) {
    try { await mutate(async (sql) => await sql`select sb_request_creation(${p.id}::uuid, ${pid}::uuid, ${user}, ${text})`); }
    catch (e) { if (isUserError(e)) return void (await msg.reply(`❌ ${userMessage(e)}`)); throw e; }
    await msg.reply("✅ We'll set up your APT Sports account and message you here when it's ready.");
  }
  s.sbUser = undefined; s.acctQueue = (s.acctQueue ?? []).slice(1); s.pending = undefined;
  await askNextAccount(fromMessage(msg), msg.author.id);
}

/** Clubs picker for the next platform with >1 club, else deposit methods. */
async function askClubsOrMethods(send: Sender, playerId: string): Promise<void> {
  const next = await db()<{ id: string; name: string }[]>`
    select pf.id, pf.name from platforms pf join player_platforms pp on pp.platform_id = pf.id
     where pp.player_id = ${playerId} and pp.active
       and (select count(*) from clubs c where c.platform_id = pf.id and c.enabled) > 1
       and not exists (select 1 from player_clubs pc join clubs c on c.id = pc.club_id where pc.player_id = ${playerId} and c.platform_id = pf.id)
     order by pf.sort_order limit 1`;
  if (!next.length) {
    await mutate(async (sql) => {
      const singles = await sql<{ platform_id: string; club_id: string }[]>`
        select pf.id platform_id, (select c.id from clubs c where c.platform_id = pf.id and c.enabled limit 1) club_id
          from platforms pf join player_platforms pp on pp.platform_id = pf.id
         where pp.player_id = ${playerId} and pp.active
           and (select count(*) from clubs c where c.platform_id = pf.id and c.enabled) = 1
           and not exists (select 1 from player_clubs pc join clubs c on c.id = pc.club_id where pc.player_id = ${playerId} and c.platform_id = pf.id)`;
      for (const s of singles) await sql`select player_set_clubs(${playerId}::uuid, ${s.platform_id}::uuid, array[${s.club_id}]::uuid[])`;
    });
    return void (await askMethods(send, playerId));
  }
  const clubs = await db()<{ id: string; name: string }[]>`select id, name from clubs where platform_id = ${next[0]!.id} and enabled order by name`;
  await send(`Which **${next[0]!.name}** club(s) will you be using? Tap all that apply, then Done.`,
    [selectRow(`ob:clubs:${next[0]!.id}`, 'Choose club(s)', clubs.map((c) => ({ label: c.name, value: c.id })), { min: 1, max: clubs.length })]);
}

export async function onClubs(i: StringSelectMenuInteraction, platformId: string): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select player_set_clubs(${p.id}::uuid, ${platformId}::uuid, ${db().array(i.values)}::uuid[])`);
  await i.update({ content: '✅ Club(s) saved.', components: [] });
  await askClubsOrMethods(fromInteraction(i), p.id);
}

async function askMethods(send: Sender, _playerId: string): Promise<void> {
  const methods = await allMethods();
  await send('Which methods do you want to use to deposit? Tap all that apply, then Done.',
    [selectRow('ob:methods', 'Deposit methods', methods.map(methodOption), { min: 1, max: Math.min(25, methods.length) })]);
}

export async function onMethods(i: StringSelectMenuInteraction): Promise<void> {
  const p = (await currentPlayer(i.user.id))!;
  await mutate(async (sql) => await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${db().array(i.values)}::uuid[])`);
  const payout = await payoutMethods();
  // Multi-select, like Telegram: pick every way you want to be paid; we then
  // collect a handle for each in turn.
  await i.update({ content: '✅ Deposit methods saved. Which methods do you want to use to withdraw? Tap all that apply, then Done.',
    components: [selectRow('ob:payoutm', 'Payout methods', payout.map(methodOption), { min: 1, max: Math.min(25, payout.length) })] });
}

export async function onPayoutMethod(i: StringSelectMenuInteraction): Promise<void> {
  const s = ses(i.user.id);
  s.wdQueue = [...i.values];
  const first = s.wdQueue.shift()!;
  s.outMethod = first;
  s.pending = 'payout_handle';
  const [m] = await db()<{ code: string; name: string; club_handle: string | null }[]>`
    select code, name, club_handle from payment_methods where id = ${first}`;
  const more = s.wdQueue.length ? `\n\n_(${s.wdQueue.length} more after this)_` : '';
  await i.update({ content: withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + more, components: [] });
}

/** Walk to the next chosen payout method that still needs a handle, or finish. */
async function askNextPayout(msg: Message): Promise<void> {
  const s = ses(msg.author.id);
  s.wdQueue = s.wdQueue ?? [];
  const next = s.wdQueue.shift();
  if (!next) {
    clearSes(msg.author.id);
    const [cfg] = await db()<{ dev_notice_enabled: boolean }[]>`select dev_notice_enabled from config where id`;
    await msg.reply(SETUP_COMPLETE + (cfg?.dev_notice_enabled ? `\n\n${DEV_NOTICE}` : ''));
    return;
  }
  s.outMethod = next;
  s.pending = 'payout_handle';
  const [m] = await db()<{ code: string; name: string; club_handle: string | null }[]>`
    select code, name, club_handle from payment_methods where id = ${next}`;
  const more = s.wdQueue.length ? `\n\n_(${s.wdQueue.length} more after this)_` : '';
  await msg.reply(withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + more);
}

export async function payoutHandleText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p || !s.outMethod) return;
  const methodId = s.outMethod;
  await mutate(async (sql) => await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${text})`);
  // Zelle is addressed by handle AND the account holder's name — collect it.
  const [m] = await db()<{ code: string }[]>`select code from payment_methods where id = ${methodId}`;
  if (m?.code === 'zelle') {
    s.pending = 'payout_name'; s.payoutHandle = text.trim();
    await msg.reply('✅ Saved your **Zelle**. What is the first and last name associated with that Zelle account?');
    return;
  }
  await msg.reply(`✅ Saved — \`${text.trim()}\`.`);
  await askNextPayout(msg);
}

export async function payoutNameText(msg: Message, text: string): Promise<void> {
  const p = await currentPlayer(msg.author.id); const s = ses(msg.author.id);
  if (!p || !s.outMethod || !s.payoutHandle) return;
  await mutate(async (sql) => await sql`select payout_handle_remember(${p.id}::uuid, ${s.outMethod!}::uuid, ${s.payoutHandle!}, null, ${text})`);
  s.payoutHandle = undefined;
  await msg.reply(`✅ Zelle name saved (**${text.trim()}**).`);
  await askNextPayout(msg);
}

function summary(name: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(`You're all set, ${name}`).setDescription(COMMANDS_LIST);
}
