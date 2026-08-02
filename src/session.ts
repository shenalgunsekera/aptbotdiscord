/**
 * In-memory flow state, keyed by Discord user id.
 *
 * The Telegram bot keeps sessions in Postgres because it's serverless (no memory
 * between requests). This bot is a single persistent process, so a plain Map is
 * enough — the only cost is that a process restart drops in-progress flows, and
 * the player just re-runs the command. Durable state (deposits, fills, requests)
 * always lives in the database, never here.
 */
/** What the next TYPED chat message from this player answers. Everything is
 *  collected in chat now — no modals. */
export type Pending =
  | 'name' | 'acct' | 'clubgg_user' | 'sb_user' | 'sb_pass'
  | 'payout_handle' | 'payout_name' | 'dep_amount' | 'wd_amount' | 'wd_handle' | 'wd_reduce'
  | 'edit_payout' | 'edit_payout_name' | 'edit_acct' | 'edit_clubgg_user' | 'cancel_amount';

export interface Session {
  pending?: Pending;
  acctQueue?: string[];       // platform ids still needing an account id (onboarding/editplatform)
  sbCreate?: boolean;         // the queued Sportsbook account is a create-for-me
  sbUser?: string;            // desired Sportsbook username while collecting the password
  reduceWd?: string;          // withdraw id being partially taken back
  // onboarding
  platforms?: string[];
  clubSel?: string[];
  depMethods?: string[];
  wdQueue?: string[];      // chosen payout methods still needing a handle (multi-select)
  clubggUid?: string;      // ClubGG ID stashed while we ask for the username
  cancelWithdrawId?: string; // which cash-out a partial-cancel amount applies to
  // deposit
  addPlatform?: string;
  addMethod?: string;
  addFillId?: string;      // awaiting a receipt image for this fill
  stripePlatform?: string; // awaiting a Stripe receipt image
  // withdraw
  outPlatform?: string;
  outAmount?: number;
  outMethod?: string;
  payoutHandle?: string;   // Zelle: the handle we just saved, awaiting the holder name
  // edit flows
  editAddPlatforms?: string[];   // platforms being added via /editplatform (awaiting account ids)
  editBlocked?: string[];        // platforms that couldn't be removed (open activity)
  // sportsbook create-account branch
  sbUsername?: string;
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
