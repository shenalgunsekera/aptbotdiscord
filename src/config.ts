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
};
