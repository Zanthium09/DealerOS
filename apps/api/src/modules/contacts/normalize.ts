// §5.1 — column mapping, phone/email normalisation, dedupeKey. Pure functions.
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { Row } from './parse';

/** The Dealer fields an import can fill. `businessName` is the only required one. */
export const IMPORT_FIELDS = [
  'businessName',
  'contactPersonName',
  'phone',
  'email',
  'region',
  'city',
  'state',
  'businessCategory',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** field → source header(s). phone/email may name several columns. */
export type ColumnMapping = Partial<Record<ImportField, string | string[]>>;

// Header aliases seen in real dealer lists. Matched on a squashed form so
// "Business Name", "business_name" and "BUSINESSNAME" all land the same.
const ALIASES: Record<ImportField, string[]> = {
  businessName: ['businessname', 'business', 'firmname', 'firm', 'shopname', 'shop', 'partyname', 'party', 'dealername', 'dealer', 'companyname', 'company', 'name'],
  contactPersonName: ['contactperson', 'contactpersonname', 'contactname', 'contact', 'ownername', 'owner', 'personname', 'proprietor'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contactno', 'contactnumber', 'whatsapp', 'whatsappno', 'telephone', 'landline', 'cell'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  region: ['region', 'zone', 'area', 'territory'],
  city: ['city', 'town', 'district', 'place'],
  state: ['state', 'province'],
  businessCategory: ['category', 'businesscategory', 'segment', 'type', 'businesstype', 'trade'],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A *suggestion*, never applied on its own — §5.1 makes the mapping interactive,
 * so the caller confirms it before anything is imported.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    const aliases = ALIASES[field];
    const hits = headers.filter((h) => !taken.has(h) && aliases.includes(squash(h)));
    if (hits.length === 0) continue;
    for (const h of hits) taken.add(h);
    // Only phone and email are genuinely multi-valued on a Dealer (§4).
    mapping[field] = field === 'phone' || field === 'email' ? hits : hits[0];
  }
  return mapping;
}

export type NormalizedPhone = { raw: string; e164: string | null; valid: boolean };

export type NormalizedRow = {
  businessName: string;
  contactPersonName: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  businessCategory: string | null;
  phones: NormalizedPhone[];
  emails: string[];
  dedupeKey: string;
};

function pick(row: Row, mapped: string | string[] | undefined): string[] {
  if (!mapped) return [];
  const headers = Array.isArray(mapped) ? mapped : [mapped];
  return headers.map((h) => (row[h] ?? '').trim()).filter((v) => v !== '');
}

const one = (row: Row, mapped: string | string[] | undefined): string | null =>
  pick(row, mapped)[0] ?? null;

/**
 * §5.1: default region IN, store BOTH raw and E.164, and **flag** an unparseable
 * number rather than dropping it. A dealer whose number we could not parse is
 * still a dealer, and the raw string is the only way anyone can fix it later.
 */
export function normalizePhone(raw: string): NormalizedPhone {
  const parsed = parsePhoneNumberFromString(raw, 'IN');
  const valid = parsed?.isValid() ?? false;
  return { raw, e164: valid ? parsed!.number : null, valid };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A coarse grouping key stored on the Dealer, not the dedup decision itself —
 * that is DedupService, which matches on indexed columns (§5.1 priority order).
 */
export function dedupeKeyFor(row: {
  phones: NormalizedPhone[];
  emails: string[];
  businessName: string;
  city: string | null;
}): string {
  const e164 = row.phones.find((p) => p.e164)?.e164;
  if (e164) return `p:${e164}`;
  if (row.emails[0]) return `e:${row.emails[0]}`;
  return `n:${squash(row.businessName)}|${squash(row.city ?? '')}`;
}

export function normalizeRow(row: Row, mapping: ColumnMapping): NormalizedRow {
  const phones = pick(row, mapping.phone)
    // One cell often holds "9876543210 / 022-12345678".
    .flatMap((v) => v.split(/[,;/]| or /i))
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map(normalizePhone);
  const emails = [
    ...new Set(
      pick(row, mapping.email)
        .flatMap((v) => v.split(/[,;\s]+/))
        .map((v) => v.replace(/^[<"']+|[>"']+$/g, ''))
        // A free-text cell ("Microdots Consultancy <info@x.com>") splits into
        // several non-email tokens alongside the real one — only a token with
        // an "@" was ever an email to begin with; the rest is not data to keep,
        // it never was an address (§1.4's "absent is null, never a guess" spirit).
        .filter((v) => v.includes('@'))
        .map(normalizeEmail),
    ),
  ];

  const base = {
    businessName: (one(row, mapping.businessName) ?? '').trim(),
    contactPersonName: one(row, mapping.contactPersonName),
    region: one(row, mapping.region),
    city: one(row, mapping.city),
    state: one(row, mapping.state),
    businessCategory: one(row, mapping.businessCategory),
    phones,
    emails,
  };
  return { ...base, dedupeKey: dedupeKeyFor(base) };
}
