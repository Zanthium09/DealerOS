// §5.9 — the ordering bot's language, as pure functions. Nothing here is a model: a message
// is either a command it knows, an order line it can match EXACTLY against the product
// list, or something it does not handle (which goes to a person). Guessing is the failure
// mode — a misread quantity becomes a real order — so every ambiguity resolves to "ask".

export type Command = 'HUMAN' | 'CANCEL' | 'CONFIRM' | 'REORDER' | 'CATALOG' | 'MENU' | 'ORDER' | 'UNKNOWN';

const norm = (t: string) => t.trim().toLowerCase().replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ');

const RE = {
  human: /\b(human|agent|person|representative|talk to (a |some ?one)|speak to|call me)\b/,
  cancel: /^(cancel|cancel order|discard|clear|start over|no)$/,
  // Deliberately strict. "ok", "yes", "haan" answer whatever was asked last and are exactly
  // what a dealer types about something else; an order is placed only on the word CONFIRM.
  confirm: /^(confirm|confirm order|yes confirm|confirmed)$/,
  reorder: /^(reorder|re-order|repeat|repeat order|same as last|same as last time|last order)$/,
  catalog: /^(catalog|catalogue|products|product list|price ?list|list|items)$/,
  menu: /^(hi|hii|hello|hey|menu|order|start|help|namaste)$/,
};

/** Order matters: asking for a person beats everything, cancelling beats confirming. */
export function classify(text: string, orderLines: number): Command {
  const t = norm(text);
  if (!t) return 'UNKNOWN';
  if (RE.human.test(t)) return 'HUMAN';
  if (RE.cancel.test(t)) return 'CANCEL';
  if (RE.confirm.test(t)) return 'CONFIRM';
  if (RE.reorder.test(t)) return 'REORDER';
  if (RE.catalog.test(t)) return 'CATALOG';
  if (RE.menu.test(t)) return 'MENU';
  return orderLines > 0 ? 'ORDER' : 'UNKNOWN';
}

// ---- reading order lines -------------------------------------------------------------

export type ParsedLine = { sku: string; quantity: number };
export type Parsed = { lines: ParsedLine[]; unclear: string[] };

const SEP = /[\n,;]+/;
// "SKU x 10", "SKU 10", "SKU-10"... and the other way round: "10 x SKU", "10 SKU".
const A = /^(.+?)\s*(?:x|×|\*|=|:|-)?\s*(\d+)$/i;
const B = /^(\d+)\s*(?:x|×|\*|=|:|-)?\s*(.+)$/i;

/**
 * Turns "A1 x 10, B2 5" into lines — matched against the KNOWN skus only, never guessed.
 * A token is accepted only when exactly one reading names a real SKU and the other is a
 * whole positive number. Anything else (unknown code, "2.5", a code that is also a valid
 * number on the other side, a quantity of zero) is returned in `unclear` so the dealer is
 * asked, not assumed. Repeats of a SKU are summed and shown back to them.
 */
export function parseOrderText(text: string, skus: Map<string, string>): Parsed {
  const lines = new Map<string, number>();
  const unclear: string[] = [];
  for (const raw of text.split(SEP)) {
    const token = raw.trim();
    if (!token) continue;
    const readings: ParsedLine[] = [];
    const a = token.match(A);
    if (a && skus.has(a[1].trim().toLowerCase())) readings.push({ sku: skus.get(a[1].trim().toLowerCase())!, quantity: Number(a[2]) });
    const b = token.match(B);
    if (b && skus.has(b[2].trim().toLowerCase())) readings.push({ sku: skus.get(b[2].trim().toLowerCase())!, quantity: Number(b[1]) });
    const distinct = new Set(readings.map((r) => `${r.sku}:${r.quantity}`));
    if (distinct.size !== 1 || readings[0].quantity < 1 || !Number.isSafeInteger(readings[0].quantity)) {
      unclear.push(token);
      continue;
    }
    lines.set(readings[0].sku, (lines.get(readings[0].sku) ?? 0) + readings[0].quantity);
  }
  return { lines: [...lines].map(([sku, quantity]) => ({ sku, quantity })), unclear };
}

/** Lower-cased SKU → canonical SKU, the lookup parseOrderText needs. */
export const skuIndex = (skus: string[]) => new Map(skus.map((s) => [s.trim().toLowerCase(), s]));

// ---- money, in whole paise, never floats ----------------------------------------------

export const toPaise = (rupees: number | string) => Math.round(Number(rupees) * 100);

export type Line = { sku: string; productName: string; quantity: number; unitPrice: number };

export const lineTotalPaise = (l: Line) => toPaise(l.unitPrice) * l.quantity;
export const orderTotalPaise = (lines: Line[]) => lines.reduce((n, l) => n + lineTotalPaise(l), 0);

export const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Lines whose quantity is over the cap — refused, not clamped: silently trimming 5000 to
 *  500 would place a different order than the dealer typed. */
export const overCap = (lines: ParsedLine[], cap: number) => lines.filter((l) => l.quantity > cap);

/** Whether the prices the dealer was shown are still the current prices (checked again on
 *  CONFIRM — a price list re-imported in between must not be quietly charged). */
export function pricesChanged(shown: Line[], current: Map<string, { unitPrice: number; active: boolean }>): boolean {
  return shown.some((l) => {
    const c = current.get(l.sku);
    return !c || !c.active || toPaise(c.unitPrice) !== toPaise(l.unitPrice);
  });
}

// ---- the words the bot says ------------------------------------------------------------
// Every number below is interpolated from a database value or arithmetic in this file;
// none is typed prose. Every reply ends with the way out (§5.9: always offer a human).

export const HUMAN_HINT = 'Reply HUMAN any time to talk to a person.';

export function summary(lines: Line[]): string {
  const rows = lines.map((l, i) => `${i + 1}. ${l.productName} (${l.sku}) — ${l.quantity} × ${inr(toPaise(l.unitPrice))} = ${inr(lineTotalPaise(l))}`);
  return [
    'Your order:',
    ...rows,
    `Total: ${inr(orderTotalPaise(lines))}`,
    '',
    'Reply CONFIRM to place this order, or CANCEL to discard it. To change it, send the full list again.',
    HUMAN_HINT,
  ].join('\n');
}

export const menuText = [
  'Hello! You can order here:',
  '• Send items like:  A1 x 10, B2 x 5   (product code and quantity)',
  '• CATALOG — see product codes and prices',
  '• REORDER — repeat your last order',
  HUMAN_HINT,
].join('\n');

export function catalogText(products: { sku: string; name: string; unitPrice: number }[], total: number): string {
  const rows = products.map((p) => `${p.sku} — ${p.name} — ${inr(toPaise(p.unitPrice))}`);
  return [
    'Product codes and prices:',
    ...rows,
    ...(total > products.length ? [`…and ${total - products.length} more — ask us for the full list.`] : []),
    '',
    'To order, send the code and quantity, like:  A1 x 10',
    HUMAN_HINT,
  ].join('\n');
}

export const clarify = (unclear: string[]) =>
  `I could not read: ${unclear.map((u) => `"${u}"`).join(', ')}. Please send each item as product code and quantity, like A1 x 10 — codes are listed under CATALOG. ${HUMAN_HINT}`;
