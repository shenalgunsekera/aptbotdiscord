import {
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  type RepliableInteraction, type Message,
} from 'discord.js';
import { db } from './db.js';
import type { PaymentMethod, Platform } from './core/index.js';

/** Reply or follow-up depending on whether the interaction was already answered. */
export async function say(i: RepliableInteraction, content: string, components: any[] = []): Promise<void> {
  const body = { content, components, ephemeral: true } as const;
  if (i.replied || i.deferred) await i.followUp(body);
  else await i.reply(body);
}

/** Post a visible (non-ephemeral) prompt so the player can answer by typing in chat. */
export async function sayChat(i: RepliableInteraction, content: string): Promise<void> {
  if (i.replied || i.deferred) await i.followUp({ content, ephemeral: false });
  else await i.reply({ content, ephemeral: false });
}

/** Send a message into the channel a player's message came from (their ticket). */
export async function sendChannel(msg: Message, content: string, components: any[] = []): Promise<void> {
  const ch = msg.channel as unknown as { send?: (o: unknown) => Promise<unknown> };
  if (ch && typeof ch.send === 'function') await ch.send({ content, components });
}

export const isCrypto = (m: PaymentMethod) => m.reversibility === 'irreversible' && m.settlement === 'club';

/** Full coin names for the crypto rails — shown as the option description so the
 *  list reads e.g. "BTC" with "Bitcoin" underneath. */
const CRYPTO_NAMES: Record<string, string> = {
  btc: 'Bitcoin', eth: 'Ethereum', ltc: 'Litecoin', sol: 'Solana', xrp: 'XRP (Ripple)',
  usdt_trc20: 'Tether — TRON (TRC-20)', usdt_erc20: 'Tether — Ethereum (ERC-20)', usdc_base: 'USD Coin — Base',
};

/** Turn a payment method into a select-menu option; crypto gets its full name as
 *  the description. */
export function methodOption(m: { id: string; name: string; code: string }): { label: string; value: string; description?: string } {
  const full = CRYPTO_NAMES[m.code];
  return full ? { label: m.name, value: m.id, description: full } : { label: m.name, value: m.id };
}

/** Platforms the player has a CONFIRMED, active account on. */
export async function confirmedPlatforms(playerId: string): Promise<Platform[]> {
  return db()<Platform[]>`
    select pf.* from platforms pf
      join player_platforms pp on pp.platform_id = pf.id
     where pp.player_id = ${playerId} and pp.platform_uid is not null and pp.active and pf.enabled
     order by pf.sort_order`;
}

/** The player's chosen deposit methods (all enabled if they never narrowed it),
 *  fiat first and crypto at the bottom. */
export async function depositMethods(playerId: string): Promise<PaymentMethod[]> {
  return db()<PaymentMethod[]>`
    select m.* from payment_methods m
     where m.enabled and (
       exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId} and pmp.method_id = m.id)
       or not exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId}))
     order by (m.reversibility = 'irreversible' and m.settlement = 'club'), m.sort_order, m.name`;
}

/** Payout-enabled methods, fiat first and crypto at the bottom. */
export async function payoutMethods(): Promise<PaymentMethod[]> {
  return db()<PaymentMethod[]>`
    select m.* from payment_methods m where m.enabled and m.payout_enabled
     order by (m.reversibility = 'irreversible' and m.settlement = 'club'), m.sort_order, m.name`;
}

/** All enabled methods, fiat first and crypto at the bottom. */
export async function allMethods(): Promise<PaymentMethod[]> {
  return db()<PaymentMethod[]>`
    select m.* from payment_methods m where m.enabled
     order by (m.reversibility = 'irreversible' and m.settlement = 'club'), m.sort_order, m.name`;
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
