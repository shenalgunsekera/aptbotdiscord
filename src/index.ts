import dns from 'node:dns';
import { createServer } from 'node:http';
import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  type Interaction, type Message,
} from 'discord.js';

// Force IPv4-first DNS resolution BEFORE any network stack initializes. On some
// container hosts (Render), IPv6 egress to Discord silently black-holes: the REST
// call inside client.login() — and the gateway WebSocket — connect to an AAAA
// address whose packets vanish, so the connection HANGS with no error at all until
// our watchdog force-restarts. That was the whole outage: dead-silent logs, "up but
// never ready", every command "did not respond" — while the identical token + code
// reach READY in ~2s locally over IPv4. Node defaults to 'verbatim' (often IPv6
// first); pinning IPv4-first makes outbound resolve to A records so the connection
// actually completes. Also settable without a deploy via NODE_OPTIONS=
// --dns-result-order=ipv4first, but baking it in means it can never regress.
dns.setDefaultResultOrder('ipv4first');
import { CONFIG } from './config.js';
import { db } from './db.js';
import { ses } from './session.js';
import { registerCommands } from './register-commands.js';
import { Notifier } from './notifier.js';
import * as start from './commands/start.js';
import * as deposit from './commands/deposit.js';
import * as withdraw from './commands/withdraw.js';
import * as reads from './commands/reads.js';
import * as edit from './commands/edit.js';
import * as admin from './commands/admin.js';
import { onReceiptMessage } from './commands/receipt.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// Never let a stray async error take the whole bot down. A failed DB call in
// some corner would otherwise knock out EVERY command. Log and keep serving;
// per-interaction handlers already catch and report their own errors.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
client.on(Events.Error, (e) => console.error('[discord client error]', e));
client.on(Events.ShardError, (e) => console.error('[discord shard error]', e));

// Track the gateway connection so /health tells the truth and a dead gateway can
// self-heal. "did not respond" on every command = the process is up but the
// gateway silently died and discord.js never reconnected — a zombie.
let hasBeenReady = false;
const BOOT = Date.now();
// Allow a GENEROUS window to reach the gateway before force-restarting. A short
// window is actively harmful: a full process restart resets discord.js's own
// reconnect backoff, so restarting every ~90s during a gateway connect rate-limit
// (which rapid redeploys trigger) just hammers it and keeps it from ever
// connecting. 10 min lets discord.js back off and reconnect on its own; we only
// force a restart if it's still dead well past that.
const CONNECT_GRACE_MS = 600_000;
client.on(Events.ShardDisconnect, (ev, id) => console.error(`[gateway] shard ${id} disconnected (code ${ev.code})`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[gateway] shard ${id} reconnecting`));
client.on(Events.ShardResume, (id) => console.log(`[gateway] shard ${id} resumed`));
// Watchdog: exit so the host restarts us fresh whenever the gateway is not ready
// and either (a) it WAS ready and has since dropped, or (b) it has NEVER connected
// within the grace window — a login that failed or a shard stuck Idle. Case (b) is
// what left the bot "up but dead" (health 200, but every command → "did not
// respond"): the old watchdog only handled (a). A fresh restart re-attempts the
// gateway, which clears a transient connect rate-limit from rapid redeploys.
setInterval(() => {
  if (client.isReady()) return;
  if (hasBeenReady || Date.now() - BOOT > CONNECT_GRACE_MS) {
    console.error('[watchdog] gateway not ready — exiting for a clean restart');
    process.exit(1);
  }
}, 30_000).unref();

client.once(Events.ClientReady, (c) => {
  hasBeenReady = true;
  console.log(`[discord] logged in as ${c.user.tag}`);
  new Notifier(c).start();
  // Keep the single DB connection exercised so any idle-drop is recovered BETWEEN
  // commands, never in the middle of one (which is what made every command "not
  // respond"). Cheap round-trip every 3 min; unref so it never holds the process.
  setInterval(() => { void db()`select 1`.then(() => {}, (e) => console.error('[db keepalive]', e?.message ?? e)); }, 3 * 60_000).unref();
});

// Chat is where everything is answered: a typed message either answers a pending
// prompt (name, amount, handle, …) or is a receipt image upload.
client.on(Events.MessageCreate, (msg) => { void handleMessage(msg).catch((e) => console.error('[msg]', e)); });

async function handleMessage(msg: Message): Promise<void> {
  if (msg.author.bot) return;
  // Staff replying in the admin channel to a "payment handle needed" request.
  // Self-gating: only a tracked request message matches, so it's a no-op elsewhere.
  if (msg.reference?.messageId && (await deposit.handleStaffReply(msg))) return;
  const pending = ses(msg.author.id).pending;
  // Admin uploading a payment-receipt screenshot (may be an image with no text).
  if (pending === 'pay_receipt') return void (await admin.payReceipt(msg));
  const text = msg.content.trim();
  if (pending && text) return void (await routeText(msg, pending, text));
  await onReceiptMessage(msg);
}

async function routeText(msg: Message, pending: string, text: string): Promise<void> {
  switch (pending) {
    case 'name': return void (await start.nameText(msg, text));
    case 'acct': return void (await start.acctText(msg, text));
    case 'clubgg_user': return void (await start.clubggUserText(msg, text));
    case 'edit_clubgg_user': return void (await edit.clubggUserText(msg, text));
    case 'sb_user': return void (await start.sbUserText(msg, text));
    case 'sb_pass': return void (await start.sbPassText(msg, text));
    case 'payout_handle': return void (await start.payoutHandleText(msg, text));
    case 'payout_name': return void (await start.payoutNameText(msg, text));
    case 'edit_payout_name': return void (await edit.payoutNameText(msg, text));
    case 'dep_amount': return void (await deposit.onAmountText(msg, text));
    case 'wd_amount': return void (await withdraw.onAmountText(msg, text));
    case 'wd_handle': return void (await withdraw.onHandleText(msg, text));
    case 'wd_reduce': return void (await withdraw.onReduceText(msg, text));
    case 'wd_topup_amount': return void (await withdraw.onTopupAmountText(msg, text));
    case 'w2_amount': return void (await withdraw.onW2AmountText(msg, text));
    case 'cancel_amount': return void (await withdraw.onCancelAmountText(msg, text));
    case 'edit_payout': return void (await edit.payoutHandleText(msg, text));
    case 'edit_acct': return void (await edit.acctText(msg, text));
  }
}

client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // NOTE: we deliberately do NOT update the player's ticket channel here. It's
    // anchored to wherever they ran /start, so every notification lands in that
    // one ticket — not wherever the player happens to click next.
    if (i.isChatInputCommand()) return void (await onSlash(i));
    if (i.isStringSelectMenu() || i.isButton() || i.isModalSubmit()) return void (await onComponent(i));
  } catch (err) {
    console.error('[discord] interaction error:', err);
    await replyError(i);
  }
});

async function onSlash(i: any): Promise<void> {
  switch (i.commandName) {
    case 'start': return void (await start.start(i));
    case 'deposit': return void (await deposit.deposit(i));
    case 'canceldeposit': return void (await deposit.cancelDeposit(i));
    case 'withdraw': return void (await withdraw.withdraw(i));
    case 'cancelwithdraw': return void (await withdraw.cancelWithdraw(i));
    case 'addtowithdraw': return void (await withdraw.addToWithdraw(i));
    case 'withdraw2': return void (await withdraw.withdraw2(i));
    case 'pending': return void (await reads.pending(i));
    case 'withdrawalhistory': return void (await reads.withdrawalHistory(i));
    case 'deposithistory': return void (await reads.depositHistory(i));
    case 'guide': return void (await reads.guide(i));
    case 'support': return void (await reads.support(i));
    case 'stop': return void (await reads.stop(i));
    case 'editplatform': return void (await edit.editPlatform(i));
    case 'editclubs': return void (await edit.editClubs(i));
    case 'editdeposit': return void (await edit.editDeposit(i));
    case 'editwithdraw': return void (await edit.editWithdraw(i));
    case 'ping': return void (await i.reply({ ephemeral: true, content: '🏓 pong' }));
    case 'pausewithdraw': return void (await admin.pauseWithdraw(i));
    case 'resumewithdraw': return void (await admin.resumeWithdraw(i));
    case 'adjust': return void (await admin.adjustCmd(i));
    case 'reversepayment': return void (await admin.reversePayment(i));
    case 'paymentchannel': return void (await admin.setChannel(i, 'payments'));
    case 'adminchannel': return void (await admin.setChannel(i, 'admin'));
    case 'escalations': return void (await admin.setChannel(i, 'escalation'));
    case 'setadmin': return void (await admin.setAdmin(i));
    case 'totals': return void (await admin.totalsCmd(i));
    default: await i.reply({ ephemeral: true, content: 'Unknown command.' });
  }
}

/** Route a component/modal interaction by its custom_id ("head:...:args"). */
async function onComponent(i: any): Promise<void> {
  const id: string = i.customId;
  const parts = id.split(':');
  const arg = parts[parts.length - 1]!;         // last segment (an id) for most
  const p2 = parts.slice(2).join(':');           // remainder after head:sub

  // ── onboarding (selects + buttons; text is handled in chat) ──
  if (id === 'ob:platforms') return void (await start.onPlatforms(i));
  if (id === 'ob:sbyes') return void (await start.onSbHas(i, true));
  if (id === 'ob:sbno') return void (await start.onSbHas(i, false));
  if (id.startsWith('ob:clubs:')) return void (await start.onClubs(i, parts[2]!));
  if (id === 'ob:methods') return void (await start.onMethods(i));
  if (id === 'ob:payoutm') return void (await start.onPayoutMethod(i));

  // ── edit ──
  if (id === 'ed:methods') return void (await edit.onMethods(i));
  if (id === 'ed:payoutm') return void (await edit.onPayoutMethod(i));
  if (id === 'ed:clubpf') return void (await edit.onClubPlatform(i));
  if (id.startsWith('ed:clubs:')) return void (await edit.onClubs(i, parts[2]!));
  if (id === 'ed:platforms') return void (await edit.onPlatforms(i));

  // ── deposit ──
  if (id === 'add:pf') return void (await deposit.onPlatform(i));
  if (id === 'add:club') return void (await deposit.onClub(i));
  if (id === 'add:m') return void (await deposit.onMethod(i));
  if (id.startsWith('pp:backup:')) return void (await deposit.peerpayBackup(i, arg));
  if (id.startsWith('dep:skip:')) return void (await deposit.onDepositSkip(i, arg));

  // ── withdraw ──
  if (id === 'out:pf') return void (await withdraw.onPlatform(i));
  if (id === 'out:club') return void (await withdraw.onClub(i));
  if (id === 'out:m') return void (await withdraw.onMethod(i));
  if (id.startsWith('wd:retract:')) return void (await withdraw.retract(i, arg));
  if (id.startsWith('wc:pick:')) return void (await withdraw.cancelPick(i, arg));
  if (id.startsWith('wc:full:')) return void (await withdraw.cancelFull(i, arg));
  if (id.startsWith('wc:part:')) return void (await withdraw.cancelPart(i, arg));
  if (id.startsWith('wd:reduce:')) return void (await withdraw.reducePrompt(i, arg));
  if (id.startsWith('wt:pick:')) return void (await withdraw.topupPick(i, arg));
  if (id === 'w2:pf') return void (await withdraw.onPlatform2(i));
  if (id === 'w2:a') return void (await withdraw.onPickA2(i));
  if (id === 'w2:b') return void (await withdraw.onPickB2(i));

  // ── admin ──
  if (id.startsWith('pl:approve:')) return void (await admin.approve(i, arg));
  if (id.startsWith('rvp:')) return void (await admin.reversePaymentPick(i, arg));
  if (id.startsWith('fl:verify:')) return void (await admin.verify(i, arg));
  if (id.startsWith('fv:verify:')) return void (await admin.verify(i, arg));
  if (id.startsWith('fv:discard:')) return void (await admin.discard(i, arg));
  if (id.startsWith('lo:claim:')) return void (await admin.loaderClaim(i, arg));
  if (id.startsWith('lo:done:')) return void (await admin.loaderDone(i, parts[2]!, Number(parts[3])));
  if (id.startsWith('lo:fail:')) return void (await admin.loaderFail(i, arg));
  if (id.startsWith('lo:failreason:')) return void (await admin.loaderFailReason(i, arg));
  if (id.startsWith('lo:short:')) return void (await admin.loaderShort(i, arg));
  if (id.startsWith('lo:shortamt:')) return void (await admin.loaderShortAmount(i, arg));
  if (id.startsWith('wd:pay:')) return void (await admin.withdrawPay(i, arg));
  if (id.startsWith('sb:made:')) return void (await admin.sbMade(i, arg));
  if (id.startsWith('st:ok:')) return void (await admin.stripeOk(i, arg));
  if (id.startsWith('st:discard:')) return void (await admin.stripeDiscard(i, arg));
  if (id.startsWith('st:credit:')) return void (await admin.stripeCredit(i, arg));
  if (id.startsWith('st:creditamt:')) return void (await admin.stripeCreditAmount(i, arg));

  void p2;
  if (i.isRepliable()) await i.reply({ ephemeral: true, content: 'That control has expired — run the command again.' });
}

async function replyError(i: Interaction): Promise<void> {
  if (!('isRepliable' in i) || !i.isRepliable()) return;
  const body = { content: 'Something went wrong. Nothing was changed.', flags: MessageFlags.Ephemeral } as const;
  try { if (i.replied || i.deferred) await i.followUp(body); else await i.reply(body); } catch { /* gone */ }
}

// Tiny health server. Free hosts (Render, Koyeb) expect a web service to bind a
// port, and an uptime pinger hitting this URL keeps a free instance from sleeping.
// Harmless everywhere else (a VM just ignores it).
function startHealthServer(): void {
  const port = Number(process.env.PORT ?? 8080);
  createServer((_req, res) => {
    // 200 during the initial connect GRACE window, then reflect real readiness.
    // The grace is what unblocks Render's zero-downtime deploy: a bot token has ONE
    // gateway session, so a brand-new instance is briefly not-ready while the old
    // one still holds it — returning 503 there deadlocks the deploy (old won't die
    // until new is healthy; new can't connect until old dies) and it times out.
    // After the grace, a not-ready gateway is a real problem → 503 (and the
    // watchdog restarts us). So: fast deploys AND a dead gateway can't hide.
    const ready = client.isReady();
    const healthy = ready || Date.now() - BOOT < CONNECT_GRACE_MS;
    const body = JSON.stringify({ ready, wsStatus: client.ws.status, ping: client.ws.ping });
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(body);
  }).listen(port, () => console.log(`[health] listening on ${port}`));
}

// Keep the free Render instance AWAKE. Render spins a free web service down after
// ~15 min with no INBOUND HTTP — and everything else this process does (the DB
// keepalive, the cron driver) is OUTBOUND, so it doesn't count. A spun-down
// instance can't ack a Discord interaction in time → "the application did not
// respond". So we hit our OWN public URL on a timer: that request goes out and
// back through Render's edge as inbound traffic, resetting the idle clock. Runs
// well under the 15-min threshold so the bot is never asleep when a command lands.
function startSelfPing(): void {
  const base = process.env.RENDER_EXTERNAL_URL
    ?? process.env.SELF_URL
    ?? 'https://aptbotdiscord.onrender.com';
  const url = base.replace(/\/+$/, '') + '/health';
  const ping = async (): Promise<void> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try { await fetch(url, { signal: ac.signal }); }
    catch (e) { console.error('[self-ping] failed:', (e as Error).message); }
    finally { clearTimeout(timer); }
  };
  setInterval(() => { void ping(); }, 10 * 60_000);
  void ping();   // once on boot
  console.log('[self-ping] keeping', url, 'warm every 10m');
}

// This always-on process drives the panel's cron every minute so crypto/email
// detection + sweeps run near-instantly, independent of GitHub Actions (which can
// be down). Idempotent on the panel side; unset CRON_SECRET = no-op.
function startCronDriver(): void {
  if (!CONFIG.cronSecret) {
    console.warn('[cron-driver] CRON_SECRET not set — crypto/email polling will only run on the daily Vercel cron');
    return;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;   // never overlap — a slow cron run must not stack up
    running = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
      const r = await fetch(CONFIG.cronUrl, { headers: { Authorization: `Bearer ${CONFIG.cronSecret}` }, signal: ac.signal });
      if (!r.ok) console.error('[cron-driver] cron returned', r.status);
    } catch (e) { console.error('[cron-driver] ping failed:', (e as Error).message); }
    finally { clearTimeout(timer); running = false; }
  };
  setInterval(() => { void tick(); }, 60_000);
  void tick();   // once on boot
  console.log('[cron-driver] driving', CONFIG.cronUrl, 'every 60s');
}

async function main(): Promise<void> {
  startHealthServer();
  startSelfPing();
  startCronDriver();
  // Connect to Discord FIRST so the bot comes ONLINE immediately. Registering
  // slash commands afterwards means a slow/hanging call or a bad DISCORD_GUILD_ID
  // can never block the login (which was leaving the bot offline).
  try {
    // Hard timeout: client.login() resolves once the REST handshake succeeds and
    // the shard is spawned — normally < 5s. If it instead HANGS (an IPv6 black-hole,
    // a network stall), don't sit silent until the 10-min watchdog: fail fast so the
    // host restarts and retries within seconds.
    await Promise.race([
      client.login(CONFIG.token),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('login() hung for 30s — no gateway handshake')), 30_000)),
    ]);
  } catch (e) {
    console.error(
      '[discord] LOGIN FAILED — check that DISCORD_TOKEN is correct, and that Privileged ' +
      'Gateway Intents (especially MESSAGE CONTENT) are ON in the Discord Developer Portal ' +
      '→ your app → Bot. Exiting so the host restarts and retries (often a transient gateway ' +
      'rate-limit after rapid redeploys):', e);
    process.exit(1);   // don't sit up with no gateway — restart and retry the login
  }
  try {
    await registerCommands();
  } catch (e) {
    console.error('[discord] command registration failed (bot is online; some commands may be missing):', e);
  }
}
void main();
