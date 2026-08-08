import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export const CONFIG = {
  token: req('DISCORD_TOKEN'),
  appId: req('DISCORD_APP_ID'),
  /** If set, commands register to this one guild instantly (great for dev). */
  guildId: process.env.DISCORD_GUILD_ID || undefined,
  // This is the one process that's ALWAYS on (Render), so it drives the panel's
  // /api/cron every minute — crypto/email polling + sweeps run near-instantly
  // instead of waiting for the once-a-day Vercel cron (GitHub Actions, the
  // intended driver, can be down — e.g. an account billing lock). Set CRON_SECRET
  // on Render to the same value as the panel; unset = no-op (daily cron only).
  cronUrl: process.env.CRON_URL || 'https://aptbot-panel-virid.vercel.app/api/cron',
  cronSecret: process.env.CRON_SECRET || '',
};
