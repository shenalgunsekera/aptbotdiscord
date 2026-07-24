import { db as coreDb, type Sql } from './core/index.js';

export { isUserError, userMessage } from './core/index.js';
export type { Sql } from './core/index.js';
export const db = coreDb;

/**
 * Run mutating DB work as Discord.
 *
 * Every notification the shared plpgsql emits is tagged with whichever front-end
 * triggered it (see d0001). We flag this connection as 'discord' for the duration
 * of the transaction, so notify_player / notify_admins stamp platform='discord'
 * and only THIS bot's notifier picks them up — the Telegram bot never sees them.
 *
 * Use this for any `select some_function(...)` that moves money or notifies.
 * Plain reads can use db() directly.
 */
export async function mutate<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const result = await coreDb().begin(async (tx) => {
    await tx`select set_config('app.platform', 'discord', true)`;
    return fn(tx as unknown as Sql);
  });
  return result as unknown as T;
}
