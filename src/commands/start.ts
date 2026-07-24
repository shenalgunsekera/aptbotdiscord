import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, EmbedBuilder,
  type ChatInputCommandInteraction, type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { registerPlayer, currentPlayer } from '../identity.js';

/**
 * /start — begin (or resume) setup.
 *
 * Discord-native: text is collected with a Modal, choices with a select menu.
 * This is the Discord port of the Telegram guided onboarding; it walks the same
 * DB (player_register → set name → platforms → …).
 */
export async function start(i: ChatInputCommandInteraction): Promise<void> {
  const channelId = i.channelId;
  const p = await registerPlayer(i.user.id, i.user.username, channelId);

  // No name yet → collect it first (Modals must be the initial reply, so we can't
  // defer here).
  if (!p.display_name || !p.display_name.trim()) {
    await i.showModal(nameModal());
    return;
  }

  // Already set up (has a name) → summary. Full flow continues from platforms.
  await i.reply({ ephemeral: true, embeds: [summaryEmbed(p.display_name)] });
  await askPlatforms(i);
}

function nameModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('ob:name')
    .setTitle('Welcome! What should we call you?')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Your name')
          .setPlaceholder('The name you actually go by')
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(40)
          .setRequired(true),
      ),
    );
}

/** Modal submit for the name. */
export async function onName(i: ModalSubmitInteraction): Promise<void> {
  const name = i.fields.getTextInputValue('name').trim();
  const p = await currentPlayer(i.user.id);
  if (!p) { await i.reply({ ephemeral: true, content: 'Send /start to begin.' }); return; }
  try {
    await mutate((sql) => sql`select player_set_name(${p.id}::uuid, ${name})`);
  } catch (e) {
    if (isUserError(e)) { await i.reply({ ephemeral: true, content: `❌ ${userMessage(e)}` }); return; }
    throw e;
  }
  await i.reply({ ephemeral: true, content: `👋 Nice to meet you, **${name}**.` });
  await askPlatforms(i);
}

/** Show the platform multi-select. */
async function askPlatforms(i: ChatInputCommandInteraction | ModalSubmitInteraction): Promise<void> {
  const platforms = await db()<{ id: string; name: string }[]>`
    select id, name from platforms where enabled order by sort_order`;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ob:platforms')
    .setPlaceholder('Which platform(s) do you play on?')
    .setMinValues(1)
    .setMaxValues(platforms.length)
    .addOptions(platforms.map((pf) => ({ label: pf.name, value: pf.id })));
  await i.followUp({
    ephemeral: true,
    content: 'Where do you play? Pick all that apply.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

/** Player picked their platform(s). (Account/club/method collection lands next.) */
export async function onPlatforms(i: StringSelectMenuInteraction): Promise<void> {
  const p = await currentPlayer(i.user.id);
  if (!p) { await i.reply({ ephemeral: true, content: 'Send /start to begin.' }); return; }
  const names = await db()<{ name: string }[]>`
    select name from platforms where id = any(${db().array(i.values)}::uuid[]) order by sort_order`;
  await i.update({
    content: `✅ Playing on: **${names.map((n) => n.name).join(', ')}**\n\n_Setup continues here — account details next._`,
    components: [],
  });
  // TODO(next): per-platform account collection → clubs → deposit methods → payout.
}

function summaryEmbed(name: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`You're all set, ${name}`)
    .setDescription(
      '💵 `/deposit` — add money\n' +
      '💸 `/withdraw` — cash out\n' +
      '📋 `/pending` — your account\n' +
      '📖 `/guide` — what each command does',
    );
}
