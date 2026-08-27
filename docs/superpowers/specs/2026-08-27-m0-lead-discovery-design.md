# M0 — Lead Discovery — Design

**Date:** 2026-08-27
**Status:** Approved, not yet implemented
**Parent spec:** `CLAUDE.md` (DealerOS project specification)

---

## 1. Purpose

Every module in the current spec assumes dealers already exist in the system — imported from
a CSV, met at a trade fair, walked in as an inquiry. M0 is the module that finds businesses
that are not on any list yet.

M0 sits *before* M1. It does not create dealers. It produces reviewed candidates that a human
promotes into the existing M1 pipeline:

```
M0 discovery → LeadCandidate → human review → Dealer(stage: NEW, source: DISCOVERED) → M2 email
```

M0 owns no dealer data, writes no messages, and sends nothing. It is an intake funnel.

---

## 2. Legal position

This is the constraint that shapes the whole module, so it is stated first.

### 2.1 What the module will not do

Enforced in code, not in documentation:

- **No scraping of sites whose terms forbid automated access.** IndiaMART, JustDial and
  TradeIndia are blocklisted by domain. The blocklist lives in configuration so it can grow
  without a deploy.
- **No CAPTCHA solving or bypass**, by any means, on any site.
- **No fetching content behind a login.**
- **No IP rotation, User-Agent spoofing, or any other evasion of a block.** A block is an
  answer, not an obstacle.
- **No ignoring `robots.txt`.**

A staff member who wants a listing from a blocklisted site opens it in their own browser and
types the details in. A person reading a public website is always fine. The system simply
never automates that.

### 2.2 Data protection

India's DPDP Act 2023 governs personal data of individuals. Business information of a
registered company — legal name, office landline, registered address — is not personal data.
**Most Indian dealers are sole proprietorships, where the business phone is the owner's
personal mobile.** M0 therefore treats every discovered contact as if it were personal data.

Consequences, all of which fall out of rules already in the parent spec:

- Every candidate stores `sourceUrl` and `capturedAt`. Provenance is never null. This is the
  §16.2 requirement made structural.
- Promotion creates `ConsentLog` rows with state `UNKNOWN`, never `OPTED_IN`. Discovery is
  not consent.
- Cold outreach to a discovered lead is email-only (§1.2), with working one-click
  unsubscribe (§6).
- Warm-routing (§7) already requires real engagement before WhatsApp. A discovered lead is
  therefore structurally incapable of receiving a WhatsApp message until they reply to an
  email or opt in directly. No new guard is required.

### 2.3 Outstanding

A lawyer has not reviewed this. §16.5 of the parent spec already books a DPDP consultation
before storing real dealer data at volume; M0's provenance model should be on that agenda.

---

## 3. Architecture

Three intake paths, one output, one review queue.

```
  Places API crawl  ─┐
  Registry lookup   ─┼→  LeadCandidate (PENDING)  →  human review  →  Dealer (NEW)
  Extractor         ─┘         ↑
                          M1 dedup service
```

All three paths implement one interface, per §1.7 of the parent spec:

```ts
interface DiscoveryProvider {
  run(params: DiscoveryParams): Promise<RawLead[]>;
}
```

Implementations: `PlacesProvider`, `RegistryProvider`, `ExtractionProvider`. Feature code never
calls Google or fetches a URL directly.

Every run executes as a BullMQ job. A crawl takes minutes; nothing runs inline in a request.

Module lives at `/apps/api/src/modules/lead-discovery`.

---

## 4. Data model

Two new tables. Both carry `organizationId`, both get a scoping test, per §18.

### DiscoveryRun — one search or one fetch

```
id, organizationId
method        PLACES_API | REGISTRY | URL_EXTRACT | FILE_EXTRACT
query         JSON — {city, category} or {url} or {filename}
status        RUNNING | COMPLETED | FAILED | REFUSED
refusalReason ROBOTS_DISALLOWED | BLOCKLISTED_DOMAIN | LOGIN_WALL | BLOCKED_BY_SITE
              (null unless status = REFUSED)
resultCount, costPaise
triggeredByUserId, startedAt, finishedAt, error?
```

`REFUSED` is a first-class outcome, not an error. Staff pasting a blocklisted URL see
"this domain is blocklisted — open it yourself and add the dealer manually", and the refusal
is logged.

`costPaise` feeds the cost tracking in §14 of the parent spec. The owner sees discovery spend
next to message spend.

### LeadCandidate — one found business, not yet a dealer

```
id, organizationId, discoveryRunId
businessName, contactPersonName?
rawPhones[], rawEmails[], address, city, state, category
sourceUrl, capturedAt        — provenance. Never null.
rawPayload  JSON             — exactly what the source returned
dedupeStatus  UNIQUE | POSSIBLE_DUPLICATE | CONFIRMED_DUPLICATE
matchedDealerId?, matchScore
status        PENDING | APPROVED | REJECTED | DUPLICATE
reviewedByUserId?, reviewedAt?, promotedDealerId?
createdAt
```

`rawPayload` earns its place twice: re-parsing later without re-fetching, and standing as
evidence of what the source actually said if provenance is ever questioned.

### Changes to existing tables

- `Dealer.source` gains one value: `DISCOVERED`. Which *kind* of discovery lives on the
  `LeadCandidate` that promoted it — three enum values doing one job is not worth it.
- Nothing else changes. No new columns on `Dealer`, `ConsentLog`, or `InteractionEvent`.

---

## 5. Reuse

**Deduplication is M1's dedup service**, called with a candidate instead of a CSV row. Same
priority order — exact `phoneE164` → exact email → fuzzy `businessName + city` via `pg_trgm` —
and the same absolute rule: **never auto-merge on a fuzzy match**. One function, two callers.
When the logic changes, it changes once.

Phone normalisation is the same `libphonenumber-js` path as §5.1, default region `IN`, raw and
E.164 both stored, unparseable numbers flagged on the candidate rather than dropped.

**The review queue is not the Approval Queue.** It borrows the §9 design language — one screen,
batch decisions, full context visible — but shares neither table nor service. `MessageDraft`
approves outbound text; this approves the existence of a business record. Forcing one through
the other would be an abstraction serving nobody.

---

## 6. Intake paths

### 6.1 Places API crawl — the volume engine

Staff choose city and category. The job runs a text search, paginates, then issues a Place
Details call per result to obtain the phone number.

**Two billable calls per business.** Text search returns name and address; phone and website
require the details lookup. Cost is estimated before the run and shown for confirmation — the
same gate pattern as WhatsApp campaign cost in §7.

> Confirm current Places API pricing before finalising the estimator. Google has repriced this
> API more than once; a hardcoded rate will silently drift wrong.

Google's terms limit how long their data may be cached. Store what the review decision needs,
promote promptly, do not accumulate a shadow copy of Google Maps. Once a candidate is promoted
the resulting `Dealer` is the business's own record.

**Deduplicate within the run as well as against existing dealers.** One shop appearing as three
listings is common.

Failure modes: quota exhausted, invalid key, zero results for an unrecognised category. All end
the run as `FAILED` with the reason visible — never a silently empty queue.

### 6.2 Registry lookup — verification, not discovery

The GST taxpayer search portal is CAPTCHA-gated. Bypassing that is excluded by §2.1, so this
path does not crawl.

Instead: staff enter a GSTIN against a candidate or dealer, and the system verifies and
enriches it — legal name, registration status, state, filing status — through a **licensed GST
verification API** or MCA's paid data service.

This path finds nothing on its own. It turns "a business name someone typed" into "a verified
legal entity", which is real value when judging whether a lead is worth pursuing.

**Ships last of the three.** Which vendor, at what cost, returning what fields, is a §16-class
unknown — do not guess it. Build 6.1 and 6.3 first; the `DiscoveryProvider` interface leaves
the slot open.

### 6.3 Extractor — the long tail

Two entry points with different legal weight.

**File upload** — PDF, image, spreadsheet. The staff member already has the file. No fetch, no
`robots.txt`, no blocklist. Straight to extraction. This handles trade fair booklets and
association directories, and is the least legally complicated path in the module.

**URL fetch** — gated in this order, before any content is requested:

1. Domain checked against the blocklist → `REFUSED`, reason shown
2. `robots.txt` fetched and parsed → disallowed → `REFUSED`
3. Fetched with an honest User-Agent naming the business, one connection at a time, polite
   delay between requests
4. Response is a login page, CAPTCHA, or 403 → `REFUSED`. Never retried under a different
   identity.

Extraction is then identical for both entry points. Content goes to the AI with a **typed
output schema**: businessName, contactPersonName, phones, emails, address, city, category.

**The AI extracts. It never fills gaps.** A field absent from the source becomes `null`, never
a plausible guess. This is §1.4's principle aimed at a different target — there the model must
not invent a number, here it must not invent a business. A hallucinated phone number is a week
of staff time spent calling a stranger.

Enforced by validating model output against the schema and rejecting any row whose values do
not appear in the source text.

Failure modes: JavaScript-rendered page arrives empty, scanned PDF with no text layer, page
containing no business listings. Each ends `FAILED` with the reason, and the raw content is
retained so a human can see what actually came back.

---

## 7. Promotion — the only path from candidate to dealer

Approving a `PENDING` candidate, in one transaction:

1. Create `Dealer` — `pipelineStage: NEW`, `source: DISCOVERED`, org-scoped
2. Create `ConsentLog` rows — `EMAIL: UNKNOWN`, `WHATSAPP: UNKNOWN`, source `IMPORT_DEFAULT`
3. Write `AuditEvent` — which admin or user approved, from which candidate, which run,
   which URL
4. Set `promotedDealerId` on the candidate

No other code path creates a `Dealer` from discovery data.

A candidate with `dedupeStatus: CONFIRMED_DUPLICATE` cannot be approved. The action is absent
from the UI, and the service rejects the call if made anyway.

---

## 8. Operational requirements

**Kill switch** (§12.6). One command pauses all discovery runs across the organization.
Crawling is outward-facing; if the User-Agent is annoying someone, the response is a
thirty-second pause, not a deploy.

**Staging guard** (§12.7). Outside production, the Places and Registry paths hit fixtures and
never the live APIs — enforced in code, not configuration. A test loop burning quota is the
cheap version of the mistake; a rate-limit ban is the expensive one.

**Rate limiting.** One concurrent request per domain, with a delay between requests. Discovery
uses the throttle service in `/core/throttle` rather than inventing its own.

---

## 9. Tests that must exist

Per §13 of the parent spec, these are money paths:

- Blocklisted domain is refused — including with scheme, subdomain, and trailing-path variants
- `robots.txt` disallow is honoured
- A 403, login page, or CAPTCHA response results in `REFUSED` and is never retried
- Extraction output containing a value absent from the source text is rejected
- Dedup against existing dealers uses M1's service and never auto-merges on fuzzy match
- Promotion writes `ConsentLog` rows in state `UNKNOWN`, never `OPTED_IN`
- A `CONFIRMED_DUPLICATE` candidate cannot be promoted, including by direct service call
- Both new tables reject queries missing an `organizationId` filter
- Staging guard blocks live API calls outside production

---

## 10. Build order

M0 depends on M1's dedup service, so it cannot be first. It slots after M1 and before or
alongside M2:

```
foundation → approval queue + drafting → InteractionEvent + webhooks
→ order/payment sync → M1 → M0 → M2 → M3 → M4 → M5 → M7 → M6 → M8
```

Within M0: extractor (file upload) → extractor (URL fetch) → Places crawl → registry lookup.
File upload first because it has no legal gating and proves the extraction pipeline; registry
last because it depends on an unresolved vendor question.

---

## 11. Open questions

1. **GST/MCA verification vendor** — which one, cost per lookup, fields returned. Blocks §6.2.
2. **Current Places API pricing** — confirm before building the cost estimator.
3. **Google data caching terms** — confirm the permitted retention window for unpromoted
   candidates, and set a purge job accordingly.
4. **DPDP review of the provenance model** — fold into the §16.5 consultation.
