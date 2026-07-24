import { db, mutate } from './db.js';
import type { Player } from './core/index.js';

/**
 * The Discord equivalent of the Telegram bot's currentPlayer/player_register.
 * A player is identified by their Discord user id; the "chat" is the ticket
 * channel they're talking to us in, which we auto-record on every touch.
 */
export async function currentPlayer(discordId: string): Promise<Player | null> {
  const [p] = await db()<Player[]>`
    select p.* from players p
      join discord_players dp on dp.player_id = p.id
     where dp.discord_id = ${discordId}`;
  return p ?? null;
}

/** Find-or-create the player and remember the ticket channel they're in. */
export async function registerPlayer(discordId: string, username: string | null, channelId: string | null): Promise<Player> {
  return mutate(async (sql) => {
    const [p] = await sql<Player[]>`
      select * from discord_player_register(${discordId}, ${username}, ${channelId})`;
    return p!;
  });
}

/** Cheap "where to reach them" refresh — call on every interaction. */
export async function touchChannel(discordId: string, channelId: string | null): Promise<void> {
  await db()`select discord_touch_channel(${discordId}, ${channelId})`;
}

/** Resolve an admin's shared admins.id from their Discord user id, or null. */
export async function currentAdmin(discordId: string): Promise<{ id: string } | null> {
  const [a] = await db()<{ id: string }[]>`
    select a.id from admins a
      join discord_admins da on da.admin_id = a.id
     where da.discord_id = ${discordId} and not a.disabled`;
  return a ?? null;
}
