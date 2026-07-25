import {
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  type RepliableInteraction,
} from 'discord.js';
import { db } from './db.js';
import type { PaymentMethod, Platform } from './core/index.js';

/** Reply or follow-up depending on whether the interaction was already answered. */
export async function say(i: RepliableInteraction, content: string, components: any[] = []): Promise<void> {
  const body = { content, components, ephemeral: true } as const;
  if (i.replied || i.deferred) await i.followUp(body);
  else await i.reply(body);
}

export const isCrypto = (m: PaymentMethod) => m.reversibility === 'irreversible' && m.settlement === 'club';

/** Platforms the player has a CONFIRMED, active account on. */
export async function confirmedPlatforms(playerId: string): Promise<Platform[]> {
  return db()<Platform[]>`
    select pf.* from platforms pf
      join player_platforms pp on pp.platform_id = pf.id
     where pp.player_id = ${playerId} and pp.platform_uid is not null and pp.active and pf.enabled
     order by pf.sort_order`;
}

/** The player's chosen deposit methods (all enabled if they never narrowed it). */
export async function depositMethods(playerId: string): Promise<PaymentMethod[]> {
  return db()<PaymentMethod[]>`
    select m.* from payment_methods m
     where m.enabled and (
       exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId} and pmp.method_id = m.id)
       or not exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId}))
     order by m.sort_order, m.name`;
}

export function selectRow(customId: string, placeholder: string, options: { label: string; value: string; description?: string }[], opts: { min?: number; max?: number } = {}) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(opts.min ?? 1)
    .setMaxValues(opts.max ?? 1)
    .addOptions(options.slice(0, 25));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buttonRow(...buttons: [label: string, id: string, style?: ButtonStyle][]) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const [label, id, style] of buttons) row.addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style ?? ButtonStyle.Primary));
  return row;
}
