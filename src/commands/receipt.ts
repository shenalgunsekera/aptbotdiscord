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
  // A player may attach up to TWO screenshots in one message. Discord delivers
  // them all on this single message, so we collect them here (no album race like
  // Telegram has). Keep at most two, in the order sent.
  const atts = [...msg.attachments.values()]
    .filter((a) => (a.contentType ?? '').startsWith('image') || /\.(png|jpe?g|webp|pdf)$/i.test(a.name ?? ''))
    .slice(0, 2);
  const att = atts[0];
  if (!att) return;

  const p = await currentPlayer(msg.author.id);
  if (!p) return;
  const s = ses(msg.author.id);

  // Stripe (fixed-link) receipt — one image is all we need.
  if (s.stripePlatform) {
    await handleStripe(msg, att.url, p.id, s.stripePlatform, att.contentType ?? 'image/jpeg', s.stripeAmount);
    s.stripePlatform = undefined;
    s.stripeAmount = undefined;
    return;
  }

  // Deposit receipt: session fill, else the player's latest pending fill. Include
  // 'awaiting_confirmation' (recent) so a SECOND screenshot sent as a separate
  // message still attaches — the first one already moved the fill off 'locked'.
  let fillId = s.addFillId;
  if (!fillId) {
    const [f] = await db()<{ id: string }[]>`
      select fl.id from fills fl join deposit_requests d on d.id = fl.deposit_id
       where d.player_id = ${p.id} and fl.status in ('locked', 'awaiting_confirmation')
         and fl.created_at > now() - interval '2 hours'
       order by fl.created_at desc limit 1`;
    fillId = f?.id;
  }
  if (!fillId) return;   // no pending deposit — ignore stray images

  // Cap at two receipts per deposit, counting any already stored (a first message).
  const [pre] = await db()<{ n: number }[]>`
    select count(*)::int n from receipts where ref_type='fill' and ref_id=${fillId}`;
  const already = pre?.n ?? 0;
  if (already >= 2) {
    clearSes(msg.author.id);
    await msg.reply('✅ Got your two screenshots already.');
    return;
  }
  const take = atts.slice(0, 2 - already);

  try {
    const [f] = await db()<{ deposit_id: string | null }[]>`select deposit_id from fills where id = ${fillId}`;
    const platformId = f?.deposit_id
      ? (await db()<{ platform_id: string }[]>`select platform_id from deposit_requests where id = ${f.deposit_id}`)[0]?.platform_id ?? null
      : null;

    // Upload every attachment FIRST (Discord CDN links expire), so a failure
    // here leaves nothing half-written and the player can simply resend. Then
    // one transaction records all receipts, submits proof, and posts the card.
    const stored: { storagePath: string; url: string; bytes: number | null; ct: string }[] = [];
    for (const a of take) {
      const ct = a.contentType ?? 'image/jpeg';
      let storagePath = a.url, url = a.url, bytes: number | null = a.size ?? null;
      if (storageConfigured()) {
        const res = await fetch(a.url);
        const s = await uploadReceipt(Buffer.from(await res.arrayBuffer()), ct, 'fill', fillId);
        storagePath = s.storagePath; url = s.url; bytes = s.bytes;
      }
      stored.push({ storagePath, url, bytes, ct });
    }
    const urls = stored.map((s) => s.url);

    await mutate(async (sql) => {
      for (const s of stored) {
        await sql`select receipt_add(${p.id}::uuid, 'fill', ${fillId}::uuid, ${s.storagePath}, ${s.url},
          ${platformId}::uuid, ${s.ct}, ${s.bytes}::bigint, null, ${p.id}::uuid, null)`;
      }
      const locked = await sql<{ id: string }[]>`select id from fills where deposit_id = ${f!.deposit_id} and status = 'locked' order by seq`;
      for (const lf of locked) await sql`select fill_submit_proof(${lf.id}::uuid, null, null, false)`;
      // Send the receipt(s) to the admin channel ONCE — on the first batch. A
      // second, separately-sent screenshot is still stored above; it just doesn't
      // raise a duplicate card (admins already have one for this deposit).
      if (already === 0) {
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
          fill_id: fillId, urls, amount: info?.amount, currency: info?.currency, method: info?.method, name: info?.name,
          from_name: info?.from_name ?? info?.name, platform: info?.platform, club: info?.club,
          payout_handle: info?.payout_handle, payout_name: info?.payout_name,
        }) as any}::jsonb)`;
      }
    });
  } catch (e) {
    if (isUserError(e)) { await msg.reply(`❌ ${userMessage(e)}`); return; }
    console.error('receipt failed:', e);
    await msg.reply("Hmm, that didn't upload. Please send it again.");
    return;
  }
  clearSes(msg.author.id);
  await msg.reply(already > 0
    ? '✅ **Got your second screenshot too.**'
    : `✅ **Got your ${take.length > 1 ? 'receipts' : 'receipt'}!** We'll check your payment and add your money — you'll get a message here the moment it's done.`);
}

async function handleStripe(msg: Message, attUrl: string, playerId: string, platformId: string, ct: string, amount?: number): Promise<void> {
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
      // The amount the player entered in the bot is the source of truth (a validated
      // figure) — NOT whatever autolink happened to match. autolink only matches by
      // recency, so it can grab a DIFFERENT player's recent Stripe event; prefer the
      // in-bot amount and fall back to the matched one only if the player gave none.
      await sql`select stripe_claim_autolink(${claim!.id}::uuid, ${amount ?? null}::bigint) as amt`;
      await sql`update stripe_claims set amount = coalesce(${amount ?? null}::bigint, amount) where id = ${claim!.id}`;
      const [cur] = await sql<{ amount: number | null }[]>`select amount from stripe_claims where id = ${claim!.id}`;
      const [pl] = await sql<{ display_name: string | null }[]>`select display_name from players where id = ${playerId}`;
      await sql`select notify_admins('stripe.claim', 'stripe_claim', ${claim!.id}::uuid, ${sql.json({
        claim_id: claim!.id, url, name: pl?.display_name, amount: cur?.amount ?? null, currency: 'USD',
      }) as any}::jsonb)`;
    });
  } catch (e) {
    console.error('stripe receipt failed:', e);
    await msg.reply("Hmm, that didn't upload. Please send it again.");
    return;
  }
  await msg.reply("✅ **Got your receipt!** We'll confirm the amount and add your money shortly.");
}
