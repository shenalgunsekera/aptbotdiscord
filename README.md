# ClubGG Union — Discord bot

A Discord front-end for the ClubGG poker union settlement system. It is a sibling
of the Telegram bot (`D:\Poker Bot Telegram`) and **shares the same Neon
database** — same ledger, deposits, withdrawals, fills, clubs, payment methods,
config, and PayPal/Cash App/crypto/Stripe payment detection.

## How it differs from the Telegram bot

| | Telegram | Discord |
|---|---|---|
| Where a player talks to the bot | their private group chat | their **ticket channel** (your existing ticket system creates these — this bot does **not**) |
| Admin surface | admin group | an admin **channel** (`config.discord_admin_channel_id`) |
| Identity | `players.telegram_id` | `discord_players` table → links to shared `players` |
| Hosting | serverless webhook (Vercel) | **persistent gateway** process (Railway / Render / Fly / VPS) — required to receive receipt image uploads |

### Identity model
Discord players are different people from Telegram players, but everything
settlement-related is shared. So Discord identity lives in its own tables
(`discord_players`, `discord_admins`) that link to the shared `players` / `admins`
rows. `players.telegram_id` is now nullable — a player is a Telegram player *or* a
Discord player. Nothing in the ledger is duplicated.

### Notification routing
Both bots share one `notifications` outbox. Each row is tagged with the
`platform` of the front-end that triggered it: the Discord bot runs its money
calls with `set local app.platform='discord'` (see `src/db.ts` → `mutate()`), so
`notify_player` / `notify_admins` stamp `platform='discord'` and only this bot's
notifier delivers them. The Telegram bot never sets the GUC, so its rows stay
`telegram`. Neither bot steals the other's messages.

## Setup

```bash
npm install
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_APP_ID, DATABASE_URL (same as Telegram), Firebase
npm run migrate           # applies db/migrations against the shared DB (safe, additive)
npm run dev               # or: npm start
```

Set `DISCORD_GUILD_ID` in `.env` during development so slash commands register
instantly to your server. Give the bot the **Message Content** privileged intent
in the Developer Portal (needed to read receipt uploads).

## Status

**Done & verified**
- Project scaffold, shared `core` (db / money / storage / types) reused.
- `db/migrations/d0001_discord_identity.sql` — identity tables, nullable
  telegram_id, `notifications.platform`, `config.discord_admin_channel_id`,
  `discord_player_register`, platform-aware `notify_*`.
- Gateway client, slash-command registration, interaction router.
- Identity resolution + auto-recorded ticket channel.
- `/start` → registers the player, collects their name (modal), platform picker.

**Next (staged port of `apps/bot`)**
- Onboarding: per-platform account collection → clubs → deposit methods → payout.
- `/deposit`, `/canceldeposit`, `/withdraw` (buttons + modals + receipt uploads).
- `/pending`, `/payments`, `/editplatform`, `/editclubs`, `/editdeposit`,
  `/editwithdraw`, `/support`, `/guide`.
- Notifier: drain the shared outbox for `platform='discord'` → player ticket
  channels + the admin channel.
- Admin actions in the admin channel (approve players, verify payments, loader jobs).
