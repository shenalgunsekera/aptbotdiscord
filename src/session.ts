/**
 * In-memory flow state, keyed by Discord user id.
 *
 * The Telegram bot keeps sessions in Postgres because it's serverless (no memory
 * between requests). This bot is a single persistent process, so a plain Map is
 * enough — the only cost is that a process restart drops in-progress flows, and
 * the player just re-runs the command. Durable state (deposits, fills, requests)
 * always lives in the database, never here.
 */
export interface Session {
  // onboarding
  platforms?: string[];
  clubSel?: string[];
  depMethods?: string[];
  // deposit
  addPlatform?: string;
  addMethod?: string;
  addFillId?: string;      // awaiting a receipt image for this fill
  stripePlatform?: string; // awaiting a Stripe receipt image
  // withdraw
  outPlatform?: string;
  outAmount?: number;
  outMethod?: string;
}

const store = new Map<string, Session>();

export function ses(discordId: string): Session {
  let s = store.get(discordId);
  if (!s) { s = {}; store.set(discordId, s); }
  return s;
}

export function clearSes(discordId: string): void {
  store.delete(discordId);
}
