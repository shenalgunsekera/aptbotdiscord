/**
 * Plain-language + money helpers, ported from the Telegram bot's words.ts so both
 * front-ends read identically to players.
 */
export const money = (minor: number, currency = 'USD'): string => {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' ';
  const num = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, '');
  return `${neg ? '-' : ''}${sym}${num}`;
};

export const whole = (minor: number, currency = 'USD'): string => money(minor, currency).replace(/\.00$/, '');

export function parseAmount(input: string): number | null {
  const cleaned = input.trim().replace(/[$£€,\s]/g, '');
  if (!cleaned) return null;
  const m = /^\+?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const wholePart = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  if (!Number.isSafeInteger(wholePart)) return null;
  const total = wholePart * 100 + frac;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function amountProblem(minor: number, opts: { min: number; max: number; step: number }): string | null {
  if (minor < opts.min) return `The smallest amount is ${whole(opts.min)}.`;
  if (minor > opts.max) return `The largest amount is ${whole(opts.max)}.`;
  if (opts.step > 0 && minor % opts.step !== 0) {
    const near = Math.max(opts.min, Math.round(minor / opts.step) * opts.step);
    return `Amounts must be in whole multiples of ${whole(opts.step)} — no cents. Try ${whole(near)}.`;
  }
  return null;
}

export function withdrawHandlePrompt(code: string, name: string, clubHandle?: string | null): string {
  const c = clubHandle ? '`' + clubHandle + '`' : 'our PayPal';
  switch (code) {
    case 'paypal':
      return `What's **your** PayPal email or tag? Send it here — that's who we pay when you cash out.\n` +
        `_(e.g. \`you@email.com\` or \`@yourtag\`)_\n\n` +
        `_When you request a cash out, send a PayPal money request to ${c} for the amount, and we'll pay it._`;
    case 'cashapp':
      return `What's **your** Cash App $cashtag? Send it here — that's where your cash-outs go.\n_(e.g. \`$yourtag\`)_`;
    case 'venmo':
      return `What's **your** Venmo username? Send it here — that's where your cash-outs go.\n_(e.g. \`@your-name\`)_`;
    case 'zelle':
      return `What's **your** Zelle? Send the **email or phone number** linked to your Zelle — that's where your cash-outs go.\n` +
        `_(e.g. \`you@email.com\` or \`555-123-4567\`)_`;
    default:
      return `What's **your** ${name} address? Send it here — that's where your cash-outs go.\n\n` +
        `⚠️ Double-check it — crypto sent to the wrong address can't come back.`;
  }
}

export function receiptInstruction(code: string): string {
  switch (code) {
    case 'venmo':  return 'a screenshot showing the **amount** and the **transaction ID**';
    case 'paypal': return 'an image showing your receipt and the **transaction ID**';
    default:       return 'a screenshot of your receipt showing the **amount sent**';
  }
}

export function cashoutConfirm(code: string, methodName: string, handle: string, amount: string, clubHandle?: string | null): string {
  const club = clubHandle ? '`' + clubHandle + '`' : 'our account';
  const copy = clubHandle ? ' _(tap to copy)_' : '';
  switch (code) {
    case 'cashapp':
    case 'paypal':
      return `✅ **Cash out started!**\n\nPlease request **${amount}** from ${club}${copy} on ${methodName}. Your request will be fulfilled in less than 24 hours.`;
    default:
      return `✅ **Cash out started!**\n\nYour ${methodName} \`${handle}\` has been added to the queue. You'll receive **${amount}** within 24 hours.`;
  }
}
