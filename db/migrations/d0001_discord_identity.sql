-- ═══════════════════════════════════════════════════════════════════════════
-- d0001 — Discord identity, layered onto the SHARED database
-- ═══════════════════════════════════════════════════════════════════════════
-- Discord players/admins are DIFFERENT people from the Telegram ones, but every
-- settlement feature (ledger, deposits, withdrawals, fills, clubs, methods,
-- config, payment detection) is shared. So Discord identity lives in its OWN
-- tables that link to the shared players/admins rows; nothing settlement-related
-- is duplicated.
--
-- Safe for the live Telegram bot: telegram_id just becomes optional, and the
-- notification/notify changes default to 'telegram' so existing behaviour is
-- unchanged.

-- A player can now be a Telegram player OR a Discord player (telegram_id null).
alter table players alter column telegram_id drop not null;

-- ── Discord player identity + their ticket channel ──
create table if not exists discord_players (
  id                uuid primary key default gen_random_uuid(),
  player_id         uuid unique not null references players(id) on delete cascade,
  discord_id        text unique not null,          -- Discord user id (snowflake)
  discord_username  text,
  ticket_channel_id text,                           -- auto-recorded: where we reply
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists discord_players_discord_idx on discord_players (discord_id);

create table if not exists discord_admins (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid unique not null references admins(id) on delete cascade,
  discord_id text unique not null,
  created_at timestamptz not null default now()
);

-- ── Route the shared notification outbox per front-end ──
-- Each bot drains only its own platform's rows. The Telegram bot never sets the
-- GUC, so its notifications stay 'telegram'; the Discord bot runs its money calls
-- with `set local app.platform='discord'`, so everything they emit is 'discord'.
alter table notifications add column if not exists platform text not null default 'telegram';
alter table config add column if not exists discord_admin_channel_id text;

create or replace function notify_player(p_player uuid, p_kind text, p_ref_type text, p_ref_id uuid, p_payload jsonb default '{}'::jsonb)
returns bigint language sql as $$
  insert into notifications (player_id, kind, ref_type, ref_id, payload, platform)
  values (p_player, p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb),
          coalesce(nullif(current_setting('app.platform', true), ''), 'telegram'))
  returning id;
$$;

create or replace function notify_admins(p_kind text, p_ref_type text, p_ref_id uuid, p_payload jsonb default '{}'::jsonb)
returns bigint language sql as $$
  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb),
          coalesce(nullif(current_setting('app.platform', true), ''), 'telegram'))
  returning id;
$$;

-- ── First contact: find-or-create the shared player + Discord identity, and
--    remember the channel they're talking to us in (their ticket). ──
create or replace function discord_player_register(p_discord_id text, p_username text, p_channel text)
returns players
language plpgsql as $$
declare
  dp discord_players;
  pl players;
begin
  select * into dp from discord_players where discord_id = p_discord_id for update;

  if found then
    update discord_players
       set discord_username  = coalesce(p_username, discord_username),
           ticket_channel_id = coalesce(p_channel, ticket_channel_id),
           updated_at        = now()
     where id = dp.id;
    select * into pl from players where id = dp.player_id;
    return pl;
  end if;

  insert into players (telegram_id, telegram_username, display_name, status)
  values (null, null, null, 'pending')
  returning * into pl;

  insert into player_prefs (player_id) values (pl.id) on conflict do nothing;
  insert into discord_players (player_id, discord_id, discord_username, ticket_channel_id)
  values (pl.id, p_discord_id, p_username, p_channel);

  perform notify_admins('player.registered', 'player', pl.id,
    jsonb_build_object('discord_id', p_discord_id, 'username', p_username, 'name', pl.display_name));
  return pl;
end $$;

-- Keep the ticket channel current on every interaction (cheap upsert of "where
-- to reach them"), without touching the rest of their record.
create or replace function discord_touch_channel(p_discord_id text, p_channel text)
returns void language sql as $$
  update discord_players set ticket_channel_id = p_channel, updated_at = now()
   where discord_id = p_discord_id and p_channel is not null;
$$;
