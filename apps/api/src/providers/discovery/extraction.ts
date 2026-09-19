// §5.0 / §10.9 — the AI extracts; it never fills gaps.
//
// §1.4 aimed at business identity instead of money: the model must not invent a number,
// and here it must not invent a business. A hallucinated phone number is a week of staff
// time spent calling a stranger. So the model's output is treated as a CLAIM about the
// source text, and every value is checked against that text — the prompt asks for
// honesty, `validateExtraction` is the guarantee (same split as drafting.service.ts).

export type RawLead = {
  businessName: string;
  contactPersonName: string | null;
  phones: string[];
  emails: string[];
  address: string | null;
  city: string | null;
  state: string | null;
  category: string | null;
};

export type Rejection = { row: unknown; reason: string };

export const EXTRACTION_SYSTEM = [
  'You extract business listings from text a person supplied — a trade fair list, an',
  'association directory, a chamber roster.',
  '',
  'Return ONLY a JSON array. Each element has exactly these keys:',
  'businessName, contactPersonName, phones, emails, address, city, state, category.',
  '',
  'Absolute rules:',
  '- Copy every value EXACTLY as it is written in the text. Do not reformat, complete,',
  '  correct, translate or infer.',
  '- If a field is not present in the text for that business, use null (or [] for phones',
  '  and emails). Never guess. Never fill a gap with something plausible.',
  '- Never invent a business. Only list businesses that are actually named in the text.',
  '- phones and emails are arrays of strings, exactly as written.',
  '- If the text contains no business listings, return [].',
  '- Output the JSON array only. No prose, no markdown.',
].join('\n');

/** Splits on line boundaries so a listing is never cut in half; bounded so one giant
 *  page cannot become an unbounded number of model calls. */
export function chunkText(text: string, size = 6000, maxChunks = 8): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    if (current.length + line.length + 1 > size && current) {
      chunks.push(current);
      current = '';
      if (chunks.length >= maxChunks) return chunks;
    }
    current += `${line}\n`;
  }
  if (current.trim() && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

/** Tolerates a fenced block or leading/trailing prose around the array. */
export function parseModelJson(output: string): unknown[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('the model returned no JSON array');
  const parsed = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('the model returned JSON that is not an array');
  return parsed;
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = (s: string) => s.replace(/\D/g, '');

/** A country-code prefix on the model's side must not sink a number that IS in the source. */
function phoneInSource(phone: string, sourceDigits: string): boolean {
  const d = digits(phone);
  if (d.length < 6) return false;
  const tail = d.length > 10 ? d.slice(-10) : d;
  return sourceDigits.includes(tail);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : []);

/**
 * Hard rules — a row is REJECTED if any of these is not in the source text: the business
 * name, any phone, any email, the contact person. Those are identity, and an invented one
 * sends a person to call or email a stranger.
 *
 * Soft fields — address, city, state, category — are set to null when they are not in
 * the source, rather than rejecting an otherwise good row. Dropping a paraphrased
 * "Distributor" costs nothing; dropping a real business because the model tidied its
 * category costs a lead. Either way, nothing not present in the source is ever kept.
 */
export function validateExtraction(rows: unknown[], sourceText: string): { accepted: RawLead[]; rejected: Rejection[] } {
  const src = alnum(sourceText);
  const srcDigits = digits(sourceText);
  const srcLower = sourceText.toLowerCase();
  const accepted: RawLead[] = [];
  const rejected: Rejection[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      rejected.push({ row, reason: 'not an object' });
      continue;
    }
    const r = row as Record<string, unknown>;
    const businessName = str(r.businessName);
    if (!businessName) {
      rejected.push({ row, reason: 'no businessName' });
      continue;
    }
    if (!src.includes(alnum(businessName))) {
      rejected.push({ row, reason: `businessName "${businessName}" does not appear in the source` });
      continue;
    }
    const phones = strArr(r.phones);
    const badPhone = phones.find((p) => !phoneInSource(p, srcDigits));
    if (badPhone) {
      rejected.push({ row, reason: `phone "${badPhone}" does not appear in the source` });
      continue;
    }
    const emails = strArr(r.emails);
    const badEmail = emails.find((e) => !srcLower.includes(e.toLowerCase()));
    if (badEmail) {
      rejected.push({ row, reason: `email "${badEmail}" does not appear in the source` });
      continue;
    }
    const contact = str(r.contactPersonName);
    if (contact && !src.includes(alnum(contact))) {
      rejected.push({ row, reason: `contact "${contact}" does not appear in the source` });
      continue;
    }
    const soft = (v: unknown) => {
      const s = str(v);
      return s && src.includes(alnum(s)) ? s : null;
    };
    accepted.push({
      businessName,
      contactPersonName: contact,
      phones,
      emails,
      address: soft(r.address),
      city: soft(r.city),
      state: soft(r.state),
      category: soft(r.category),
    });
  }
  return { accepted, rejected };
}
