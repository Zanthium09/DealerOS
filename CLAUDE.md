# DealerOS — Project Specification

> This file is the working brief for Claude Code. Read it fully before writing code.
> Rationale, market context, and commercial reasoning live in `/docs/SPEC.md`.
> This file is the *rules*; that file is the *why*.

---

## 0. What this is

A multi-tenant platform for **distribution businesses** in India covering the full dealer
lifecycle in one system:

**Find dealers → contact them → convert them → manage their orders → keep them active.**

Everything sits on **one dealer record** moving through **one pipeline**. Acquisition
modules push a dealer forward; operations modules keep them active and pull dormant ones
back. No module keeps a private copy of dealer data.

```
NEW → CONTACTED → INTERESTED → ONBOARDED → ACTIVE → DORMANT → REACTIVATED
```

The first and only customer is a real, operating distribution business (the founder's family
business). Build for that business, with real data and real dealers. Productisation for other
distributors comes later — but see §1.3: the architecture must not have to be rewritten for it.

**Do not build a generic SaaS.** Build a working internal tool architected so it can become
one without a rewrite.

---

## 1. Non-negotiables

Already decided. Do not re-litigate, do not silently substitute alternatives.

**1.1 Official channels only.**
WhatsApp goes through Meta's official Cloud API. Never unofficial libraries (Baileys,
whatsapp-web.js, Venom), browser automation of web.whatsapp.com, or virtual-number rotation.
They get banned, they break the dealer relationship, they violate Meta's ToS.

**1.2 Email is the cold channel. WhatsApp is the warm channel.**
Cold outreach to people who have never contacted us goes by email only. WhatsApp is for
contacts who have already engaged, opted in, or are existing dealers.

**1.3 Multi-tenancy from line one.**
Every table carries `organizationId`. Every query is scoped. Enforce with Prisma middleware
or Postgres RLS — a query missing the scope must fail, not leak. A cross-tenant leak is a
company-ending bug, and this is brutal to retrofit later.

**1.4 Numbers come from the database, never from the model.**
Anywhere a message contains money owed, a discount, a scheme term, or a quantity, that value
is injected from a database field as a template variable. The AI writes the sentence around
the number; it never computes, formats, or restates it. Enforce structurally — the drafting
service accepts a template plus typed variables, and the model never sees a free-text slot
where a number could be invented. **This is the single most damaging class of error the
system can produce.**

**1.5 AI drafts, humans or deterministic rules commit.**
Every AI-generated outbound message passes through `MessageDraft` before becoming an
`InteractionEvent`. Escalation ladders, ageing buckets, and dormancy thresholds are
deterministic state machines, not model decisions.

**1.6 Consent and audit are first-class.**
Consent is tracked per channel, append-only. Every message sent is logged immutably.
India's DPDP Act 2023 is consent-first with no legitimate-interest exemption.

**1.7 Providers go behind an interface.**
Email, AI, and WhatsApp providers are never called from feature code. Always through a
service layer that can be swapped.

**1.8 Monolith, not microservices.** Modules are directories in one codebase.

**1.9 Platform admin is a separate identity, not a role on tenant users.**
`AdminUser` is its own table, its own login route, its own session type. There is no `role`
value on the tenant `User` model that grants cross-org access — none, ever. A platform admin
session carries an explicit cross-org flag that only the admin auth guard can set; a tenant
user's token can never produce it, regardless of role. See §9A.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (backend and frontend) |
| Backend | NestJS |
| Database | PostgreSQL (with `pg_trgm` for fuzzy matching) |
| ORM | Prisma |
| Queue | Redis + BullMQ |
| Frontend | Next.js (App Router) + React + Tailwind + shadcn/ui |
| Charts | Recharts or Tremor |
| Auth | Better Auth or Clerk (org-aware, role-based) |
| Email | Resend to start, behind `EmailProvider` (SES swap later) |
| WhatsApp | Meta Cloud API direct — see §7 |
| AI | Anthropic API behind `AIProvider` |
| Phone parsing | `libphonenumber-js` |
| Storage | S3 or Cloudflare R2 |
| Errors | Sentry |
| Logging | Pino, structured |
| Hosting | Railway or Render (API, Postgres, Redis) + Vercel (web) |

**Do not add:** Kubernetes, microservices, GraphQL, MongoDB, hand-rolled auth, or serverless
functions for queue workers.

---

## 3. Repository layout

```
/apps
  /api                          NestJS
    /src
      /core
        /organizations
        /auth
        /tenancy                org scoping middleware + guards
        /audit                  immutable event log
        /webhooks               signature verification + idempotency
        /approval               Approval Queue service  (§9)
        /drafting               AI drafting service     (§1.4)
        /throttle               shared send throttling  (one service, not per module)
        /killswitch             per-channel pause       (§12.6)
        /platform-admin         AdminUser auth, cross-org queries, impersonation (§9A)
      /modules
        /lead-discovery         M0 — find new prospects  (§5.0)
        /contacts               M1 — prospect database
        /outreach-email         M2
        /outreach-whatsapp      M3
        /calling                M4
        /sync                   Order + Payment ingestion (shared infra, §5.5)
        /dormancy               M5
        /collections            M7
        /schemes                M6
        /ordering-bot           M8
      /providers
        /discovery              DiscoveryProvider + Places/Registry/Extraction impls
        /email                  EmailProvider + Resend/SES impls
        /whatsapp               WhatsAppProvider + Cloud API impl
        /ai                     AIProvider + Anthropic impl
  /web                          Next.js client dashboard (tenant users)
  /admin                        Next.js platform admin app — separate app, separate auth,
                                 never shares a session or login form with /web
/packages
  /shared                       types shared between api and web
/prisma
  schema.prisma
/docs
  SPEC.md                       rationale, market context, cost ledger
```

---

## 4. Data model

Every entity carries `organizationId`.

### Organization
The tenant. Owns sending domains, WhatsApp Business Account, settings, dealers.

### User
`role: OWNER | OFFICE_STAFF | SALESMAN`. Roles gate dashboard views. **Always belongs to
exactly one `organizationId`.** No role value on this table ever grants access to another
organization's data — that capability does not exist here at all, see `AdminUser` below.

### AdminUser — separate table, platform operators only
```
id, email, passwordHash (or SSO identity), role: PLATFORM_ADMIN | PLATFORM_SUPPORT
mfaEnabled, lastLoginAt, createdAt
```
No `organizationId` — deliberately. Authenticates through a distinct route
(`/admin/auth/*`, never `/auth/*`) issuing a distinct session/token type that the tenant
auth guard does not recognise and cannot accept. See §9A for the query and impersonation
pattern.

### Dealer
The central record. A prospect and a dealer are the same row at different pipeline stages.

```
id, organizationId
businessName, contactPersonName
phones[]        — array. Dealers change numbers; the WhatsApp number often
                  differs from the legacy landline. Each: { raw, e164, valid, isPrimary,
                  isWhatsapp }
emails[]        — array. Each: { address, verificationStatus, isPrimary }
region, city, state, businessCategory
source          IMPORTED_LIST | TRADE_FAIR | INQUIRY | REFERRAL | MANUAL | DISCOVERED
                (required — DISCOVERED means M0; which kind lives on the LeadCandidate)
pipelineStage   NEW | CONTACTED | INTERESTED | ONBOARDED | ACTIVE | DORMANT | REACTIVATED
                plus terminal: OPTED_OUT | INVALID
assignedSalesmanId
dedupeKey, createdAt, updatedAt
```

`verificationStatus` per email address: `UNVERIFIED | VALID | INVALID | RISKY`.
Every pipeline transition writes an `AuditEvent`.

### ConsentLog — append-only, never updated or deleted
```
id, organizationId, dealerId
channel   EMAIL | WHATSAPP | CALL
state     OPTED_IN | OPTED_OUT | UNKNOWN
source    EXPLICIT_UNSUBSCRIBE | BOUNCE | IMPORT_DEFAULT | VERBAL | INBOUND_MESSAGE
createdAt
```
**Consent is per channel, not per dealer.** An email opt-out must never silently suppress
WhatsApp. Current state = most recent row per `(dealerId, channel)`. History is the DPDP
audit trail — never destroy it.

### InteractionEvent — every touch, every channel, one table
```
id, organizationId, dealerId
channel      EMAIL | WHATSAPP | CALL
direction    OUTBOUND | INBOUND
campaignId?  messageDraftId?  providerMessageId?
status       SENT | DELIVERED | OPENED | CLICKED | REPLIED | BOUNCED | FAILED | COMPLAINED
body         the rendered text actually sent — store it, you must be able to answer
             "what exactly did we send this dealer?"
createdAt
```
This table is what makes warm-routing a real feature rather than a manual export hack.
Every outreach module writes here.

### MessageDraft — the AI output boundary
```
id, organizationId, dealerId, sourceModule
draftText, templateVariables (JSON — the DB-sourced numbers, §1.4)
containsFinancialTerms  bool
requiresApproval        bool
status   PENDING | APPROVED | REJECTED | AUTO_SENT | EDITED_AND_SENT
approvedByUserId?, autoSendRuleId?, sentAt?
```
Every AI-generated message — cold outreach, reactivation nudge, scheme pitch, payment
reminder — passes through here before becoming an `InteractionEvent`.

### SendingIdentity
```
domain, provider, verificationStatus, dkimRecords,
warmupStartedAt, currentDailyLimit
```
Per organization. Warmup ramp is per identity.

### Suppression
```
organizationId, email?, phoneE164?, reason, createdAt
```
**Scoped per organization.** An opt-out from one distributor must not suppress that contact
for another.

### Order
```
dealerId, orderDate, totalValue, lineItems[],
source   CSV_IMPORT | ORDERING_BOT | MANUAL | ACCOUNTING_SYNC
schemeId?   — attribution
```

### OrderLineItem
`orderId, sku, productName, quantity, unitPrice, lineTotal`

### Product
`sku, name, category, unitPrice, imageUrl, active`

### Scheme
`name, description, terms, applicableProductIds, validFrom, validTo, targetSegmentRule (JSON), campaignId`

### PaymentLedgerEntry
```
dealerId, invoiceRef, amount, dueDate, paidAmount, paidDate?,
ageingBucket  CURRENT | D30 | D60 | D90_PLUS   (derived)
lastSyncedAt  — load-bearing, see §10.4
```

### Campaign
`channel, name, status, segmentFilter (JSON), templateId, scheduledAt`

### AuditEvent — immutable
`organizationId, actorType (USER|SYSTEM), actorId, entityType, entityId, action, metadata, createdAt`

### DiscoveryRun — M0, one search or one fetch
```
method   PLACES_API | REGISTRY | URL_EXTRACT | FILE_EXTRACT
query (JSON), status RUNNING | COMPLETED | FAILED | REFUSED
refusalReason  ROBOTS_DISALLOWED | BLOCKLISTED_DOMAIN | LOGIN_WALL | BLOCKED_BY_SITE
resultCount, costPaise, triggeredByUserId, startedAt, finishedAt, error?
```
`REFUSED` is an outcome, not an error. `costPaise` feeds §14 cost tracking.

### LeadCandidate — M0, a found business, not yet a Dealer
```
discoveryRunId, businessName, contactPersonName?
rawPhones[], rawEmails[], address, city, state, category
sourceUrl, capturedAt   — provenance, never null (§16.2)
rawPayload (JSON)       — exactly what the source returned
dedupeStatus  UNIQUE | POSSIBLE_DUPLICATE | CONFIRMED_DUPLICATE
matchedDealerId?, matchScore
status  PENDING | APPROVED | REJECTED | DUPLICATE
reviewedByUserId?, reviewedAt?, promotedDealerId?
```
A `CONFIRMED_DUPLICATE` candidate cannot be promoted — enforced in the service, not the UI.

### WebhookEvent
`provider, providerEventId (unique), payload, processedAt` — idempotency, §8.

---

## 5. Workflow, stage by stage

**5.0 Lead discovery (M0).** Full design: `/docs/superpowers/specs/2026-08-27-m0-lead-discovery-design.md`.
Finds businesses not yet on any list. Three paths behind one `DiscoveryProvider` interface:
Google Places API crawl (licensed, the volume engine), licensed GST/MCA verification lookup
(enriches, does not discover), and a generic extractor (staff upload a file or paste a URL;
AI pulls businesses out of trade fair lists, association directories, chamber rosters).
Output is a `LeadCandidate` in a review queue — **never a Dealer directly**. A human approves;
promotion then creates the Dealer at `NEW` with `source: DISCOVERED` and `ConsentLog` rows in
state `UNKNOWN`. Discovery is not consent.
Dedup calls M1's service, not a second implementation.
**Enforced in code, not documentation:** domain blocklist for sites whose ToS forbid automated
access (IndiaMART, JustDial, TradeIndia), `robots.txt` obeyed, no CAPTCHA bypass, no fetching
behind a login, no identity rotation to evade a block. A block is an answer. Staff wanting a
blocklisted listing open it in a browser and enter it manually.
The AI extracts and never fills gaps — a field absent from the source is `null`, never a
guess. Same principle as §1.4, aimed at business identity instead of money.

**5.1 Import & dedup (M1).**
CSV/XLSX upload → interactive column mapping → normalise phones with `libphonenumber-js`
(default region `IN`, store raw and E.164, flag unparseable rather than dropping) → lowercase
emails → compute `dedupeKey`.
Match priority: exact `phoneE164` → exact email → fuzzy `businessName + city` (`pg_trgm`).
**Never auto-merge on fuzzy match.** Flagged matches go to a review queue; merges are logged
as reversible operations. A wrong merge silently corrupts two businesses' order and payment
history.
`source` is mandatory per import batch. Confirmed-new records get a Dealer row plus an
initial `ConsentLog` row.

**5.2 Email outreach (M2).**
Reads dealers where `pipelineStage = NEW` and current `ConsentLog(EMAIL) != OPTED_OUT`.
AI drafts → `MessageDraft` → cold outreach carries no financial terms, so it is auto-send
eligible after a tone/compliance check → sent via provider, throttled → webhooks populate
`InteractionEvent`.
A `BOUNCED` event auto-writes `ConsentLog(EMAIL, OPTED_OUT, source=BOUNCE)`.
A human `REPLIED` transitions `NEW → CONTACTED` and sets the warm flag read by 5.3.

**5.3 WhatsApp outreach (M3).**
Reads dealers with the warm flag, or direct opt-ins. Approved templates only — free-form
marketing outside the 24-hour window is not permitted, so **the template library is the
content**, not a suggestion. Inbound replies route through a conversation state machine
(catalog / pricing / not interested / negotiation); anything outside its scope escalates to a
human inbox rather than attempting open-ended negotiation. Positive signal transitions
`CONTACTED → INTERESTED`.

**5.4 Calling (M4).**
Human-initiated first. AI compiles a call brief from that dealer's `InteractionEvent` rows.
Outcome logged manually → `INTERESTED → ONBOARDED`.
**DLT registration is a legal precondition with its own lead time** — start it independently
of the build schedule.

**5.5 Order & payment sync — shared infrastructure, not part of any module.**
Modules 5, 6, 7 and 8 all depend on this, so build it before any of them.
Most SMB accounting setups (including Tally) expose no live API — assume a scheduled
export/import, not real-time sync. Design for a **visible sync cadence** and surface data
freshness in the dashboard so staff trust the numbers. Populates `Order` and
`PaymentLedgerEntry`; recalculates the Dealer Scorecard on every run.
**v1 is CSV/XLSX import regardless of what the accounting system turns out to be.**

**5.6 Dormancy & reactivation (M5).**
Scheduled scan for dealers with no order in N days (configurable, default 30) →
`ACTIVE → DORMANT` → AI drafts nudge → `MessageDraft` with `requiresApproval` set by a
configurable value threshold (below: auto-send; above: approval queue).
Loop closes when a new Order appears within a tracked window → `DORMANT → REACTIVATED`.

**5.7 Schemes (M6).**
Owner creates a Scheme; a segmentation rule selects dealers by category/purchase pattern; AI
personalises per segment. **Scheme terms are financial commitments, so these default to the
approval queue.** Broadcast respects the same shared throttle and opt-out logic as every
other channel.
Orders placed in the validity window are auto-tagged with `schemeId` by a matching rule
(dealer + date range + product overlap). **The attribution is the value of this module** —
without it, it is just a broadcast tool.

**5.8 Collections (M7).**
Scheduled recalculation of `ageingBucket`. The escalation ladder (gentle → firm →
flag for human call) is a deterministic state machine driven by days-overdue thresholds, not
an AI decision. AI drafts only the wording; every number is injected per §1.4. Never fully
automate the final human escalation.

**5.9 Ordering bot (M8).**
Inbound message → conversation state machine (browse catalog / reorder last / custom
quantities) → builds a draft Order → **requires explicit dealer confirmation before the Order
is finalised**, guarding against a misparsed quantity becoming a real order. Always offer a
"talk to a human" escape hatch. Finalised orders land in the same `Order` table as imports —
one order pipeline, not two.
**Requires dealer behaviour change.** Scope as a pilot with 20–30 comfortable dealers.

---

## 6. Email — provider and rules

```ts
interface EmailProvider {
  send(params: SendEmailParams): Promise<{ providerMessageId: string }>;
  verifyDomain(domain: string): Promise<DomainVerification>;
  getDomainStatus(domain: string): Promise<DomainVerification>;
  parseWebhook(payload: unknown, signature: string): EmailWebhookEvent[];
}
```
Implement `ResendProvider`. Define `SesProvider` as a stub so the swap is mechanical.

Enforce in code, not documentation:
- Never send from the organization's primary business domain. Sending identities are separate
  domains (e.g. `mail-<orgslug>.in`).
- New identity → warmup ramp, ~20/day rising over 10–14 days. The queue reads
  `currentDailyLimit`.
- Hard cap 30–50 per identity per day during and shortly after warmup.
- Never send to `INVALID` addresses or anyone on the org's Suppression list.
- SPF, DKIM and DMARC verified before an identity may send.
- Working one-click unsubscribe on every email (`List-Unsubscribe` header + link).

**Sequences.** Ordered steps: initial → follow-up 1 (N days) → follow-up 2 (M days).
A reply, click, bounce or opt-out **halts remaining steps immediately**. BullMQ delayed jobs,
cancelled on halt.

**Reply detection** — fiddlier than it looks, budget real time.
Thread on `In-Reply-To` / `References`, falling back to subject + sender. Classify inbound as
`AUTO_REPLY | BOUNCE | UNSUBSCRIBE_REQUEST | HUMAN_REPLY` — heuristics first
(`Auto-Submitted`, `X-Autoreply` headers), AI only for ambiguous cases. Only `HUMAN_REPLY`
moves a dealer to `INTERESTED`.

---

## 7. WhatsApp — Meta Cloud API direct, not a BSP

At productisation each customer needs their own WhatsApp Business Account connected via
**Tech Provider status + Embedded Signup**, which requires direct Cloud API integration.
Building on a BSP means ripping it out later. Accept that this means owning Business
Verification, template management, and quality-rating monitoring.

```ts
interface WhatsAppProvider {
  sendTemplate(params: SendTemplateParams): Promise<{ providerMessageId: string }>;
  sendFreeform(params: SendFreeformParams): Promise<{ providerMessageId: string }>;
  submitTemplate(template: TemplateDefinition): Promise<TemplateSubmission>;
  getTemplateStatus(templateId: string): Promise<TemplateStatus>;
  parseWebhook(payload: unknown, signature: string): WhatsAppWebhookEvent[];
}
```

Enforce in code:
- Outbound with no open session **must** use an approved template. Reject freeform outside a
  session — fail loudly, never silently fall back.
- Track the 24-hour service window per dealer (`sessionExpiresAt`). Freeform only while open.
- Marketing templates only to dealers with `ConsentLog(WHATSAPP) = OPTED_IN` or prior
  engagement. A guard, not a convention.
- Monitor quality rating from webhooks; auto-pause **broadcasts** (not inbound replies) below
  a threshold, alert the owner.
- Every template-dependent module needs a defined fallback for rejection or delay
  (email-only send, or human notification).
- Track cost per campaign and show it before send confirmation: ~₹1.09 per marketing message,
  ~₹0.145 per utility message in India.

**Warm-routing.** A dealer enters WhatsApp outreach only if they replied to or clicked an
email, messaged the business number first, explicitly opted in, or are already onboarded.
Implement as a query filter that cannot be bypassed from the UI.

---

## 8. Webhooks

Meta and the email provider both retry and occasionally duplicate. Without idempotency you
get double-counted opens, double-triggered pipeline transitions, and duplicate sends.

- Verify signatures on every inbound webhook. Reject unsigned or mismatched payloads.
- Insert into `WebhookEvent` with a unique constraint on `providerEventId`. On conflict, ack
  and return early.
- The HTTP handler only persists and enqueues. Processing is async via BullMQ.

---

## 9. Approval Queue — build early, build once

One shared service. Modules do not each invent their own approval screen; retrofitting four
ad hoc flows into one costs more than building it up front.

```
- Reads pending MessageDraft rows across all modules
- One UI: drafts grouped by dealer; approve / edit / reject
- Configurable auto-send thresholds per module
- Every send — auto or approved — writes an AuditEvent recording who approved it,
  or which rule triggered the auto-send
```

Design it to give reps **more** visibility and control (full dealer history on one screen),
not less. A tool that feels like surveillance gets routed around, and then the data rots.

---

## 9A. Platform admin — two logins, two guards, one audit trail

Two distinct flows exist. Do not let them share code paths beyond the database connection.

**9A.1 Client login (tenant users).**
Unchanged from the rest of the spec. A `User` authenticates, gets a session scoped to their
`organizationId` by the existing tenancy middleware (§1.3). They see only their org's data.
Nothing about this changes.

**9A.2 Platform admin login (you, and later, support staff).**
`AdminUser` authenticates through `/admin/auth/*` — a separate route, separate app
(`/apps/admin`), separate session/token type. **MFA is mandatory** on this login, not
optional, given what it can see.

The admin session carries a claim (e.g. `scope: PLATFORM`) that only the admin auth guard
issues. The regular tenancy guard does not recognise this claim — it simply does not have a
code path that grants org access from it. This is the actual safety property: it is not that
admins are "trusted to be scoped correctly," it's that **the tenant-facing query layer has no
mechanism by which a `PLATFORM` claim produces cross-org data**, so a bug in the admin app
cannot leak into client-facing access, and a bug in the client app cannot accidentally grant
platform access.

**9A.3 What a platform admin can do.**
- List all organizations: plan/status, last login, message volume, WhatsApp quality rating,
  billing status.
- View platform-wide aggregate metrics.
- **View a specific organization's data — read-only by default.** Every such view writes an
  `AuditEvent` (`actorType: ADMIN`, `action: VIEWED_ORG_DATA`) with which admin, which org,
  what was viewed, when. This is not optional logging — treat it as a DPDP-defensibility
  requirement, same standing as `ConsentLog`.
- Suspend an organization (non-payment, quality-rating damage affecting shared
  infrastructure, ToS violation). Suspension is itself an audited action.
- Write access to a tenant's data (e.g. fixing a support issue) requires an explicit
  elevated action, separately audited, never bundled into "read-only view."

**9A.4 What a platform admin never gets.**
A `PLATFORM` session never bypasses `ConsentLog`, `Suppression`, or the send-throttling
service. Admins can *view* a tenant's data; they do not get a side door that lets them send
messages as that tenant, or a bulk-export path that isn't itself audited like everything
else. If a support task needs to send something on a tenant's behalf, it goes through the
same `MessageDraft` → Approval Queue path as everyone else, attributed to the admin who
triggered it.

---

## 10. Failure modes and guardrails

| | Failure | Guardrail |
|---|---|---|
| 10.1 | Dedup error | Never auto-merge. Review queue; merges logged as reversible operations. |
| 10.2 | Consent conflict | Most recent `ConsentLog` row per channel wins. Channels independent. |
| 10.3 | Quality rating drop | Monitoring job auto-pauses broadcasts, alerts owner. |
| 10.4 | Stale payment data | Collections job checks `lastSyncedAt` before sending. Older than the freshness window → refuse to send, flag for manual check. |
| 10.5 | Numeric hallucination | §1.4 — template variables from DB fields, enforced structurally. |
| 10.6 | Template rejection | Every dependent module has a defined fallback path. |
| 10.7 | Rep adoption resistance | Architectural — see §9. |
| 10.8 | Admin session leaking cross-org access to a tenant user | Structural, not policy — the tenant query layer has no code path that accepts a `PLATFORM` claim. See §9A.2. |
| 10.9 | M0 extractor invents a business or a phone number | Typed output schema; any value not present in the source text is rejected. Absent field → `null`, never a guess. |
| 10.10 | M0 scrapes a site that forbids it | Domain blocklist + `robots.txt` check in code, before any fetch. No CAPTCHA bypass, no login-walled content, no identity rotation. §5.0. |

---

## 11. Build dependency order

The technical dependency graph — what cannot exist before what. Not the same as feature
priority.

1. **Dealer + ConsentLog + pipeline state machine + tenancy scoping + audit log** — foundation.
   Include `AdminUser` and the two-guard auth split here, not later — retrofitting a
   platform-admin identity onto an auth system built assuming "every user belongs to one
   org" is a real migration, same reasoning as §1.3.
2. **Approval Queue + drafting service** — second, not last.
3. **InteractionEvent logging + webhook ingestion** (email and WhatsApp) — before outreach is
   more than blind one-way sending.
4. **Order/payment sync pipeline** — pull forward even though it ships no visible feature.
5. **Acquisition modules** — M1 → M0 → M2 → M3 → M4. M0 comes after M1 because it calls M1's
   dedup service. Within M0: file extractor → URL extractor → Places crawl → registry lookup.
6. **Operations modules by infrastructure reuse** — M5 (dormancy) → M7 (collections, reuses
   approval + messaging almost entirely) → M6 (schemes, adds segmentation) → M8 (ordering bot,
   most new surface area).

---

## 12. Engineering discipline

**12.1 De-risk external unknowns before finalising the schema.** See §16. Most costly bugs
here come from wrong assumptions about external reality, not bad code.

**12.2 Walking skeleton before breadth.** Get one minimal path working end to end first:
import 5 real dealers → send 1 real WhatsApp template through the Approval Queue → log it →
confirm the delivery webhook lands. This surfaces integration surprises in week one instead
of week eight.

**12.3 Test the state machines exhaustively.** Pipeline stages, consent precedence, escalation
ladder. Small, pure, easily testable, and the parts most likely to carry a subtle bug with
real consequences.

**12.4 Idempotency on every webhook handler.** §8.

**12.5 Canary every automated channel.** Any module that sends automatically runs against
10–15 real dealers for a week, closely watched, before expanding. A wrong-amount reminder
caught on ten dealers is a different event from the same bug hitting two hundred.

**12.6 One-command kill switch per outbound channel.** Pause all sends on a channel without a
deploy. The difference between a thirty-second pause and a hotfix is the difference between
an incident and a damaged relationship.

**12.7 Hard separation between staging and anything touching a real dealer.** Separate Meta
test numbers, sandboxed email domain, and a **code-level guard** — not a config setting —
that refuses to send to real numbers outside production. The most common way a careful system
still causes damage is a test run against production credentials.

---

## 13. Testing — the money paths

Full coverage is not the goal. These must have real tests:

- Tenant scoping — a query without an org filter must fail, not leak
- Consent precedence across channels
- Send throttling and warmup limits
- Deduplication logic
- Sequence halting on reply / bounce / opt-out
- Suppression enforcement
- Webhook idempotency
- Ageing bucket calculation and escalation transitions
- Numbers-from-DB injection (§1.4)
- M0 blocklist and `robots.txt` refusal, including subdomain and path variants
- M0 extraction rejecting any value absent from the source text
- M0 promotion writing `ConsentLog` as `UNKNOWN`, never `OPTED_IN`

A bug that sends one dealer forty messages, or one wrong amount, destroys a relationship the
business spent years building.

---

## 14. Cross-cutting features

- **Dealer scorecard** — order frequency, average order value, payment behaviour, engagement
  score. Recalculated on every sync.
- **Referral capture** — on onboarding, ask who else they know; feeds back into M1.
- **Master dashboard** — full funnel: prospects contacted → onboarded → active → revenue.
- **Role-based views** — owner sees everything; office staff sees operations; salesman sees
  only assigned dealers.
- **Data freshness indicator** — last sync time, visible wherever synced numbers appear.
- **Cost tracking** — per-campaign message spend, shown before confirming a send.

---

## 15. Baseline metrics — capture before each module goes live

Cannot be reconstructed afterwards, and without them there is nothing to compare against.

- Cold outreach reply rate (before M2: zero, it doesn't happen today)
- Count of dormant dealers and their average historical order value (before M5)
- Average collection cycle time in days (before M7)
- Scheme uptake rate, currently unmeasured (before M6)
- Rep time per order, sampled from the manual process (before M8)

---

## 16. Known unknowns — do not guess, ask

1. **Accounting system.** Tally, Busy, Marg or Excel — unconfirmed. Tally exposes XML over
   HTTP (typically port 9000) but is poorly documented and requires Tally running and
   reachable. **Get a real export file before finalising the sync schema.** Build CSV/XLSX
   import first regardless.
2. **Prospect database provenance.** How the list was built (inquiries, trade fairs,
   purchased) determines what outreach is defensible. `source` is mandatory for this reason.
3. **Dealer digital comfort.** Whether dealers will adopt an ordering bot is unknown. M8 is
   scoped as a pilot for this reason.
4. **WhatsApp Business verification** — what it requires for this specific business and how
   long it takes. Start the process independently of the build.
5. **DPDP consultation** — thirty minutes with someone who knows the law, specifically on the
   §4 consent model, before storing real dealer data at volume.
6. **Phase 0 diagnostic** — a written, ranked pain list with rough ₹ impact per pain. This
   determines which operations module is built first and supplies §15's baselines.
7. **GST/MCA verification vendor (M0)** — which one, cost per lookup, fields returned. Blocks
   the registry path; build the other two M0 paths first.
8. **Google Places API pricing and data-caching terms** — confirm current rates before writing
   the cost estimator, and the permitted retention window for unpromoted candidates.

If a decision depends on one of these, stop and ask rather than assuming.

---

## 17. Build phases

**Phase 1 — Weeks 1–2. Foundation.**
Scaffold, Prisma schema, tenancy scoping, audit log, client auth **and platform admin auth
(§9A) as two separate flows from the start**, Approval Queue, drafting service, webhook
infrastructure. M1 (import + dedup + verification) and M2 (email outreach). Minimal
functional UI — not a polished dashboard. The admin app can be a single "list organizations"
screen at this stage; the auth separation is what matters now, not the admin feature set.
*Done when:* the walking skeleton (§12.2) passes, then 50–100 real dealers emailed with
replies detected and visible.

**Phase 2 — Weeks 3–4. WhatsApp and pipeline.**
Cloud API integration, template management, session tracking, warm-routing. First real
Next.js dashboard: unified pipeline view.

**Phase 3 — Weeks 5–9. Sync and operations.**
Order/payment sync (§5.5) first, then M5 → M7 → M6 → M8.

**Phase 4 — Weeks 10–11. Calling.**
Human-assisted first: AI call briefs from engagement history. Voice API (~₹5–6/min) only
after that proves useful. DLT/TRAI compliance is mandatory. Do not build a dialer.

**Phase 5 — Weeks 12–14. Measurement.**
Compile before/after metrics for the case study.

**Phase 6 — Month 4+. Productisation.**
Per-customer sending domains, embedded WhatsApp signup, per-tenant reputation monitoring with
auto-suspension thresholds, billing.

---

## 18. Working agreement for Claude Code

- Ask before adding a dependency not in §2.
- Ask before changing anything in §1.
- When a task touches §16, stop and ask rather than assuming.
- Write migrations, never edit the database by hand.
- Every new table gets `organizationId` and a scoping test.
- Every new outbound path gets a kill switch and a canary plan.
- Prefer boring, obvious code. Other people will read this.

---

## 19. Running it locally

```
pnpm install
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env          # then set the secrets — see the note at the top of it
pnpm prisma:deploy            # or `pnpm prisma:migrate` while changing the schema
pnpm db:seed                  # one Organization, one OWNER User, one PLATFORM_ADMIN
pnpm test                     # the whole suite
```

**Two database roles.** `DATABASE_URL` is `dealeros_app`: not the table owner, not a
superuser. `MIGRATE_DATABASE_URL` is `dealeros`, the owner, and only the two prisma
scripts above use it — which is why they are `pnpm prisma:deploy` / `pnpm
prisma:migrate` and not `npx prisma migrate deploy` (`schema.prisma` reads
`DATABASE_URL`, so `apps/api/scripts/migrate.mjs` hands it the owner URL instead).

The app used to connect as the owner, which the compose image also makes a
superuser. From that role the append-only triggers on `AuditEvent` and `ConsentLog`
were decoration — `ALTER TABLE … DISABLE TRIGGER`, `SET session_replication_role =
'replica'` and `DROP TRIGGER` all worked, and `rolbypassrls` was true, so the
Postgres RLS §1.3 offers as the alternative would have been just as void.
`apps/api/test/audit/db-role.test.ts` is the standing proof that it is not any more.

No extra setup step: migration `20260828120000_app_role_least_privilege` creates
`dealeros_app` if it is missing, so local dev stays one `docker compose up -d` and
the throwaway test database gets the same split for free. **In production, create
`dealeros_app` yourself with a real password before the first deploy** — the
migration's guarded `CREATE ROLE` then does nothing and only the grants apply. New
tables get the app role's grants automatically (`ALTER DEFAULT PRIVILEGES`); a new
append-only table needs its own `REVOKE UPDATE, DELETE, TRUNCATE`.

`pnpm test` is the only test command. It compiles `apps/api` (tests included) and then
runs `apps/api/test/run.mjs`, which creates a throwaway database from
`TEST_DATABASE_URL`, applies the migrations to it, runs every `*.test.js` under
node:test, and drops it — so the suite never touches the dev database and always runs
against the real migrated schema, triggers and all.

One runner, node:test, no test framework dependency. Tests are compiled rather than
type-stripped because Nest's DI needs `emitDecoratorMetadata`, which
`--experimental-strip-types` cannot emit.

The seeded platform admin has no MFA enrolled: enrol through `/admin/auth/mfa/enrol`
then `/admin/auth/mfa/confirm` with a real authenticator (§9A.2 — a seeded second
factor would be a shared one). Note that `/mfa/enrol` is gated on the password
alone: an attacker holding a stolen password for an admin who has never enrolled can
enrol their own authenticator. §9A.2's "MFA is mandatory" is mandatory *after*
enrolment. **Enrol the seeded admin before the host is reachable by anyone else.**

`ALLOW_DEV_SECRETS=1` prints a banner at every boot. It is the single switch that
enables the dev secret fallbacks and drops `Secure` from the session cookies; with
`NODE_ENV=production` the fallbacks are refused regardless, and the process exits at
boot rather than at the first login (`assertSecretsUsable` in `apps/api/src/main.ts`).
