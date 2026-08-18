import type { Message } from 'discord.js';
import { db, mutate, isUserError, userMessage } from '../db.js';
import { uploadReceipt, storageConfigured } from '../core/index.js';
import { currentPlayer } from '../identity.js';
import { ses, clearSes } from '../session.js';

/**
 * A player uploaded an image in their ticket. If they have a deposit awaiting a
 * receipt (or a Stripe payment), attach it and alert the admins. Discord gives us
 * a direct attachment URL; we still copy the bytes into Firebase so the proof is
 * durable (Discord CDN links expire).
 */
export async function onReceiptMessage(msg: Message): Promise<void> {
  if (msg.author.bot || !msg.attachments.size) return;
  const att = [...msg.attachments.values()].find((a) => (a.contentType ?? '').startsWith('image') || /\.(png|jpe?g|webp|pdf)$/i.test(a.name ?? ''));
  if (!att) return;

  const p = await currentPlayer(msg.author.id);
  if (!p) return;
  const s = ses(msg.author.id);

  // Stripe (fixed-link) receipt.
  if (s.stripePlatform) {
    await handleStripe(msg, att.url, p.id, s.stripePlatform, att.contentType ?? 'image/jpeg');
    s.stripePlatform = undefined;
    return;
  }

  // Deposit receipt: session fill, else the player's latest locked fill.
  let fillId = s.addFillId;
  if (!fillId) {
    const [f] = await db()<{ id: string }[]>`
      select fl.id from fills fl join deposit_requests d on d.id = fl.deposit_id
       where d.player_id = ${p.id} and fl.status = 'locked' order by fl.created_at desc limit 1`;
    fillId = f?.id;
  }
  if (!fillId) return;   // no pending deposit — ignore stray images

  try {
    const [f] = await db()<{ deposit_id: string | null }[]>`select deposit_id from fills where id = ${fillId}`;
    const platformId = f?.deposit_id
      ? (await db()<{ platform_id: string }[]>`select platform_id from deposit_requests where id = ${f.deposit_id}`)[0]?.platform_id ?? null
      : null;

    let storagePath = att.url, url = att.url, bytes: number | null = att.size ?? null, ct = att.contentType ?? 'image/jpeg';
    if (storageConfigured()) {
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const stored = await uploadReceipt(buf, ct, 'fill', fillId);
      storagePath = stored.storagePath; url = stored.url; bytes = stored.bytes;
    }

    await mutate(async (sql) => {
      await sql`select receipt_add(${p.id}::uuid, 'fill', ${fillId}::uuid, ${storagePath}, ${url},
        ${platformId}::uuid, ${ct}, ${bytes}::bigint, null, ${p.id}::uuid, null)`;
      const locked = await sql<{ id: string }[]>`select id from fills where deposit_id = ${f!.deposit_id} and status = 'locked' order by seq`;
      for (const lf of locked) await sql`select fill_submit_proof(${lf.id}::uuid, null, null, false)`;
      // Send the receipt to the admin channel for verification.
      const [info] = await sql<{ amount: number; currency: string; method: string; name: string | null; payout_handle: string | null; payout_name: string | null; from_name: string | null; platform: string | null; club: string | null }[]>`
        select f.amount, f.currency, pm.name method, dp.display_name name, f.payout_handle, f.payout_name,
               pf.name as platform, c.name as club,
               coalesce(case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end, dp.display_name) as from_name
          from fills f join payment_methods pm on pm.id = f.method_id
          left join deposit_requests d on d.id = f.deposit_id
          left join players dp on dp.id = d.player_id
          left join platforms pf on pf.id = d.platform_id
          left join player_platforms pp on pp.player_id = d.player_id and pp.platform_id = d.platform_id
          left join clubs c on c.id = pp.club_id
         where f.id = ${fillId}`;
      await sql`select notify_admins('fill.receipt_admin', 'fill', ${fillId}::uuid, ${sql.json({
        fill_id: fillId, urls: [url], amount: info?.amount, currency: info?.currency, method: info?.method, name: info?.name,
        from_name: info?.from_name ?? info?.name, platform: info?.platform, club: info?.club,
        payout_handle: info?.payout_handle, payout_name: info?.payout_name,
      }) as any}::jsonb)`;
    });
  } catch (e) {
    if (isUserError(e)) { await msg.reply(`❌ ${userMessage(e)}`); return; }
    console.error('receipt failed:', e);
    await msg.reply("Hmm, that didn't upload. Please send it again.");
    return;
  }
  clearSes(msg.author.id);
  await msg.reply("✅ **Got your receipt!** We'll check your payment and add your money — you'll get a message here the moment it's done.");
}

async function handleStripe(msg: Message, attUrl: string, playerId: string, platformId: string, ct: string): Promise<void> {
  try {
    await mutate(async (sql) => {
      const [claim] = await sql<{ id: string }[]>`insert into stripe_claims (player_id, platform_id, receipt_file_id) values (${playerId}::uuid, ${platformId}::uuid, ${attUrl}) returning id`;
      let url = attUrl;
      if (storageConfigured()) {
        const res = await fetch(attUrl);
        const stored = await uploadReceipt(Buffer.from(await res.arrayBuffer()), ct, 'stripe_claim', claim!.id);
        url = stored.url;
        await sql`update stripe_claims set receipt_url = ${url} where id = ${claim!.id}`;
      }
      const [al] = await sql<{ amt: number | null }[]>`select stripe_claim_autolink(${claim!.id}::uuid) as amt`;
      const [pl] = await sql<{ display_name: string | null }[]>`select display_name from players where id = ${playerId}`;
      await sql`select notify_admins('stripe.claim', 'stripe_claim', ${claim!.id}::uuid, ${sql.json({
        claim_id: claim!.id, url, name: pl?.display_name, amount: al?.amt ?? null, currency: 'USD',
      }) as any}::jsonb)`;
    });
  } catch (e) {
    console.error('stripe receipt failed:', e);
    await msg.reply("Hmm, that didn't upload. Please send it again.");
    return;
  }
  await msg.reply("✅ **Got your receipt!** We'll confirm the amount and add your money shortly.");
}
