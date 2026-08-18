/**
 * Mint a PeerPay (ZKP2P Pay) checkout link for a deposit. Mirror of the Telegram
 * bot's @union/core peerpay helper. The player pays through the returned URL and
 * USDC settles to the merchant's connected Base wallet; PAYMENT_SETTLED webhook
 * matches back to this fill via notes.merchantOrderId. feePayer / destination /
 * chain come from the merchant account. Returns null if unconfigured or on error.
 */
const API_BASE = 'https://api.pay.peer.xyz';
const CHECKOUT_BASE = 'https://pay.peer.xyz';
const PEERPAY_RAILS = new Set(['venmo', 'cashapp']);

export function peerpayConfigured(): boolean {
  return !!process.env.PEERPAY_API_KEY;
}

export async function peerpayCheckout(opts: {
  amountCents: number;
  fillId: string;
  rail?: string | null;
}): Promise<string | null> {
  const apiKey = process.env.PEERPAY_API_KEY;
  if (!apiKey) return null;

  const rail = opts.rail && PEERPAY_RAILS.has(opts.rail.toLowerCase()) ? opts.rail.toLowerCase() : undefined;
  const usdc = (opts.amountCents / 100).toFixed(2);

  try {
    const { createCheckout } = await import('@zkp2p/pay-sdk');
    const r = await createCheckout(
      {
        requestedUsdcAmount: usdc,
        notes: { merchantOrderId: opts.fillId, source: 'apt-bot' },
        successUrl: process.env.PEERPAY_RETURN_URL ?? null,
        cancelUrl: process.env.PEERPAY_RETURN_URL ?? null,
      },
      {
        apiBaseUrl: API_BASE,
        checkoutBaseUrl: CHECKOUT_BASE,
        apiKey,
        ...(rail ? { preselectedMethod: rail as any } : {}),
        signal: AbortSignal.timeout(15000),
      },
    );
    return r.checkoutUrl ?? null;
  } catch (err) {
    console.error('[peerpay] createCheckout failed:', err);
    return null;
  }
}
