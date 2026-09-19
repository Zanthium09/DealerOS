// Cell parsing for accounting exports. Pure — no database — so every odd format seen in
// real Indian exports is testable directly.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * dd/mm/yyyy is the Indian convention, and the dangerous one: 03/04/2026 is 3 April
 * here, 4 March in a US parser. Day-first is assumed for every slash/dash/dot form;
 * only an explicit yyyy-first ISO date is read the other way. Returns null rather than
 * guessing when a cell is not a date at all.
 */
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return utc(+m[1], +m[2] - 1, +m[3]);

  m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2,4})$/.exec(s); // 1-Apr-2026
  if (m && m[2].toLowerCase() in MONTHS) return utc(year(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s); // 31/08/2026
  if (m) return utc(year(+m[3]), +m[2] - 1, +m[1]);

  return null;
}

const year = (y: number) => (y < 100 ? 2000 + y : y);

function utc(y: number, mo: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, mo, d));
  // Date.UTC rolls 31 Feb over to 3 Mar silently — reject instead of inventing a date.
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo && date.getUTCDate() === d ? date : null;
}

/**
 * "₹1,23,456.50", "Rs. 500", "(2,000.00)" (negative), "12,000 Dr". Indian grouping
 * (1,23,456) and a trailing Dr/Cr — Tally's own convention — are both real. Returns
 * null for anything that is not a number: an unreadable amount must fail the row, not
 * become 0.
 */
export function parseMoney(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/(dr|cr)\.?$/i, (_, tag) => {
    if (/cr/i.test(tag)) negative = !negative;
    return '';
  });
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}
