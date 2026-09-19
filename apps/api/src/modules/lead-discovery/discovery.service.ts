// M0 — lead discovery (§5.0, design doc). Finds businesses that are not on any list yet.
//
//   run  → RawLead[] → dedup (M1's service) → LeadCandidate(PENDING) → human review
//                                              → promote → Dealer(NEW, DISCOVERED)
//
// Nothing here creates a Dealer except `approve`, and nothing here sends anything.
// Every run executes in the background (a fetch + several model calls outlives a request);
// the caller polls the run.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DiscoveryMethod, LeadCandidate, PrismaClient, Prisma, RefusalReason } from '@prisma/client';
import { AuditAction, AuditService } from '../../core/audit';
import { KillSwitchService } from '../../core/killswitch';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { DedupService } from '../contacts/dedup.service';
import { NormalizedRow, normalizeRow, suggestMapping } from '../contacts/normalize';
import { parseFile } from '../contacts/parse';
import {
  DiscoveryNotConfiguredError,
  DiscoveryRefusedError,
  DiscoveryResult,
  ExtractionProvider,
  htmlToLines,
  isBlocklisted,
  parseFetchableUrl,
  PlacesProvider,
  RawLead,
  RegistryProvider,
} from '../../providers/discovery';

const CHANNELS = ['EMAIL', 'WHATSAPP', 'CALL'] as const;
const TEXT_FILE = /\.(txt|md|html?|csv)$/i;
const SHEET_FILE = /\.(csv|xlsx?)$/i;
const MAX_TEXT_CHARS = 400_000;

/** RawLead → the shape M1's dedup and normalisation already understand. One code path for
 *  phones and emails (libphonenumber-js, `@` required), not a second normaliser for M0. */
export function toNormalized(lead: RawLead): NormalizedRow {
  return normalizeRow(
    {
      name: lead.businessName,
      contact: lead.contactPersonName ?? '',
      phone: lead.phones.join(', '),
      email: lead.emails.join(' '),
      city: lead.city ?? '',
      state: lead.state ?? '',
      category: lead.category ?? '',
    },
    {
      businessName: 'name',
      contactPersonName: 'contact',
      phone: 'phone',
      email: 'email',
      city: 'city',
      state: 'state',
      businessCategory: 'category',
    },
  );
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** One shop listed three times is common (design doc §6.1) — collapse within a run. */
function runKey(row: NormalizedRow): string {
  const phone = row.phones.find((p) => p.e164)?.e164;
  return phone ? `p:${phone}` : row.emails[0] ? `e:${row.emails[0]}` : `n:${alnum(row.businessName)}|${alnum(row.city ?? '')}`;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly dedup: DedupService,
    private readonly audit: AuditService,
    private readonly killSwitch: KillSwitchService,
    private readonly extraction: ExtractionProvider,
    private readonly places: PlacesProvider,
    private readonly registry: RegistryProvider,
  ) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: lead discovery has no org context (§1.3).');
    return id;
  }

  // ---- pause (§12.6) --------------------------------------------------------------

  async isPaused(): Promise<boolean> {
    if (await this.killSwitch.isPaused('DISCOVERY')) return true;
    const s = await this.prisma.outreachSettings.findFirst({ select: { discoveryPaused: true } });
    return s?.discoveryPaused ?? false;
  }

  async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    await this.prisma.outreachSettings.upsert({
      where: { organizationId: this.orgId() },
      create: { organizationId: this.orgId(), discoveryPaused: paused },
      update: { discoveryPaused: paused },
    });
    return { paused };
  }

  private async assertRunnable(): Promise<void> {
    if (await this.isPaused()) throw new ServiceUnavailableException('Lead discovery is paused for this organization.');
  }

  // ---- entry points --------------------------------------------------------------

  async startUrl(input: { url: string; userId?: string | null }) {
    await this.assertRunnable();
    const parsed = parseFetchableUrl(input.url ?? '');
    if (!parsed) throw new BadRequestException('that is not an http(s) web address');

    const run = await this.createRun('URL_EXTRACT', { url: parsed.href }, input.userId);
    // The cheapest gate is checked up front so the answer is immediate — a refusal is an
    // outcome the user should see in the response, not after a poll.
    if (isBlocklisted(parsed.href)) {
      return this.finishRefused(
        run.id,
        'BLOCKLISTED_DOMAIN',
        `${parsed.hostname} forbids automated access — open it in your browser and add the dealer manually.`,
      );
    }
    const org = await this.prisma.organization.findFirst({ select: { name: true } });
    this.detach(run.id, () =>
      this.extraction.run({ method: 'URL_EXTRACT', url: parsed.href, orgName: org?.name ?? 'DealerOS' }),
    );
    return run;
  }

  async startFile(input: { filename: string; buffer: Buffer; userId?: string | null }) {
    await this.assertRunnable();
    const { filename, buffer } = input;

    if (/\.(pdf|png|jpe?g|gif|webp|tiff?)$/i.test(filename)) {
      // Needs a PDF text-layer parser / OCR — a new dependency, which §18 says to ask
      // about rather than add. Refuse plainly instead of pretending.
      throw new BadRequestException(
        'PDF and image extraction is not enabled yet (it needs a PDF/OCR library — see CLAUDE.md §18). ' +
          'Export the list as CSV/XLSX, or paste the text into a .txt file.',
      );
    }
    if (!SHEET_FILE.test(filename) && !TEXT_FILE.test(filename)) {
      throw new BadRequestException('supported files: .csv, .xlsx, .xls, .txt, .md, .html');
    }

    const run = await this.createRun('FILE_EXTRACT', { filename }, input.userId);

    if (SHEET_FILE.test(filename)) {
      // A spreadsheet is already structured: mapped and normalised by M1's own code, no
      // model in the loop, so there is nothing for it to hallucinate.
      this.detach(run.id, () => this.fromSpreadsheet(filename, buffer), filename);
    } else {
      const text = buffer.toString('utf8').slice(0, MAX_TEXT_CHARS);
      const body = /\.html?$/i.test(filename) ? htmlToLines(text) : text;
      this.detach(run.id, () => this.extraction.run({ method: 'FILE_EXTRACT', text: body }), filename);
    }
    return run;
  }

  /** Places / registry. Both end FAILED with a clear reason until they are enabled. */
  async startProvider(input: { method: 'PLACES_API' | 'REGISTRY'; query: Record<string, string>; userId?: string | null }) {
    await this.assertRunnable();
    const run = await this.createRun(input.method, input.query, input.userId);
    this.detach(run.id, () =>
      input.method === 'PLACES_API'
        ? this.places.run({ method: 'PLACES_API', city: input.query.city ?? '', category: input.query.category ?? '' })
        : this.registry.run({ method: 'REGISTRY', gstin: input.query.gstin ?? '' }),
    );
    return run;
  }

  private async fromSpreadsheet(filename: string, buffer: Buffer): Promise<DiscoveryResult> {
    const { headers, rows } = await parseFile(filename, buffer);
    if (rows.length === 0) throw new Error('the file has no data rows');
    const mapping = suggestMapping(headers);
    if (!mapping.businessName) {
      throw new Error(`no business-name column found. Headers: ${headers.join(', ')}`);
    }
    const leads: RawLead[] = [];
    for (const row of rows) {
      const n = normalizeRow(row, mapping);
      if (!n.businessName) continue;
      leads.push({
        businessName: n.businessName,
        contactPersonName: n.contactPersonName,
        phones: n.phones.map((p) => p.raw),
        emails: n.emails,
        address: null,
        city: n.city,
        state: n.state,
        category: n.businessCategory,
      });
    }
    return { leads, excerpt: headers.join(', '), sourceUrl: `upload:${filename}`, costPaise: 0, rejectedCount: 0, truncated: false };
  }

  // ---- run lifecycle ------------------------------------------------------------

  private createRun(method: DiscoveryMethod, query: Record<string, string>, userId?: string | null) {
    return this.prisma.discoveryRun.create({
      data: { organizationId: this.orgId(), method, query, triggeredByUserId: userId ?? null },
    });
  }

  private finishRefused(runId: string, reason: RefusalReason, message: string) {
    return this.prisma.discoveryRun.update({
      where: { id: runId },
      data: { status: 'REFUSED', refusalReason: reason, error: message, finishedAt: new Date() },
    });
  }

  /** Detached from the request — see the file header. AsyncLocalStorage keeps the org
   *  context, so every query in the continuation is still tenant-scoped. */
  private detach(runId: string, work: () => Promise<DiscoveryResult>, sourceName?: string) {
    void this.execute(runId, work, sourceName).catch((err) => this.logger.error(`run ${runId}: ${err instanceof Error ? err.stack : err}`));
  }

  private async execute(runId: string, work: () => Promise<DiscoveryResult>, sourceName?: string) {
    try {
      const result = await work();
      const created = await this.persistCandidates(runId, result, sourceName);
      await this.prisma.discoveryRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          resultCount: created,
          costPaise: result.costPaise,
          rawExcerpt: result.excerpt,
          // A completed run can still carry a warning the user must see.
          error:
            [
              result.truncated ? 'The source was longer than one run reads — only the first part was processed.' : null,
              result.rejectedCount ? `${result.rejectedCount} row(s) the model produced were dropped because they were not in the source text.` : null,
              result.leads.length === 0 ? 'No business listings were found in the source.' : null,
            ]
              .filter(Boolean)
              .join(' ') || null,
        },
      });
    } catch (err) {
      if (err instanceof DiscoveryRefusedError) {
        await this.finishRefused(runId, err.reason, err.message);
      } else {
        await this.prisma.discoveryRun.update({
          where: { id: runId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: err instanceof DiscoveryNotConfiguredError || err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  private async persistCandidates(runId: string, result: DiscoveryResult, sourceName?: string): Promise<number> {
    const seen = new Set<string>();
    let created = 0;
    for (const lead of result.leads) {
      const row = toNormalized(lead);
      const key = runKey(row);
      if (seen.has(key)) continue;
      seen.add(key);

      // M1's dedup service — one function, two callers (design doc §5). Never auto-merges:
      // a fuzzy hit is POSSIBLE_DUPLICATE for a human, an exact one cannot be promoted.
      const match = await this.dedup.findMatch(row);
      const confirmed = match?.confirmed === true;
      await this.prisma.leadCandidate.create({
        data: {
          organizationId: this.orgId(),
          discoveryRunId: runId,
          businessName: lead.businessName,
          contactPersonName: lead.contactPersonName,
          rawPhones: lead.phones,
          rawEmails: lead.emails,
          address: lead.address,
          city: lead.city,
          state: lead.state,
          category: lead.category,
          // Provenance is never null (§16.2).
          sourceUrl: sourceName ? `upload:${sourceName}` : result.sourceUrl,
          capturedAt: new Date(),
          rawPayload: lead as unknown as Prisma.InputJsonValue,
          dedupeStatus: confirmed ? 'CONFIRMED_DUPLICATE' : match ? 'POSSIBLE_DUPLICATE' : 'UNIQUE',
          matchedDealerId: match?.dealerId ?? null,
          matchScore: match?.score ?? null,
          status: confirmed ? 'DUPLICATE' : 'PENDING',
        },
      });
      created++;
    }
    return created;
  }

  // ---- reads --------------------------------------------------------------------

  listRuns() {
    return this.prisma.discoveryRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
  }

  async getRun(id: string) {
    const run = await this.prisma.discoveryRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundException(`no discovery run ${id}`);
    return run;
  }

  async listCandidates(filter: { status?: string; runId?: string; take?: number }) {
    const rows = await this.prisma.leadCandidate.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.runId ? { discoveryRunId: filter.runId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.take ?? 200, 500),
      include: { run: { select: { method: true, query: true } } },
    });
    const ids = [...new Set(rows.map((r) => r.matchedDealerId).filter((x): x is string => !!x))];
    const dealers = ids.length
      ? await this.prisma.dealer.findMany({ where: { id: { in: ids } }, select: { id: true, businessName: true, city: true } })
      : [];
    const byId = new Map(dealers.map((d) => [d.id, d]));
    return rows.map((r) => ({ ...r, matchedDealer: r.matchedDealerId ? (byId.get(r.matchedDealerId) ?? null) : null }));
  }

  // ---- review -------------------------------------------------------------------

  /**
   * Promotion — the ONLY path from candidate to dealer (design doc §7). One transaction:
   * decide → Dealer(NEW, DISCOVERED) → ConsentLog UNKNOWN per channel → AuditEvent →
   * promotedDealerId. Discovery is not consent; nothing here can write OPTED_IN.
   */
  async approve(candidateId: string, userId: string): Promise<{ dealerId: string }> {
    const candidate = await this.load(candidateId);
    if (candidate.status !== 'PENDING') {
      throw new ConflictException(`candidate ${candidateId} is ${candidate.status}, not PENDING — it cannot be decided again`);
    }
    // Enforced here, not in the UI (the button is also absent there): a stored
    // CONFIRMED_DUPLICATE, or one that became a duplicate since it was found.
    if (candidate.dedupeStatus === 'CONFIRMED_DUPLICATE') {
      throw new BadRequestException('this business is already a dealer — a confirmed duplicate cannot be promoted');
    }
    const row = toNormalized(this.leadOf(candidate));
    const live = await this.dedup.findMatch(row);
    if (live?.confirmed) {
      await this.prisma.leadCandidate.updateMany({
        where: { id: candidateId, status: 'PENDING' },
        data: { status: 'DUPLICATE', dedupeStatus: 'CONFIRMED_DUPLICATE', matchedDealerId: live.dealerId, matchScore: live.score },
      });
      throw new BadRequestException('this business became a dealer since it was found — marked as a duplicate, not promoted');
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional, so two people approving at once cannot create two dealers.
      const { count } = await tx.leadCandidate.updateMany({
        where: { id: candidateId, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedByUserId: userId, reviewedAt: new Date() },
      });
      if (count === 0) throw new ConflictException(`candidate ${candidateId} was decided by someone else`);

      const dealer = await tx.dealer.create({
        data: {
          organizationId: this.orgId(),
          businessName: row.businessName,
          contactPersonName: row.contactPersonName,
          city: row.city,
          state: row.state,
          businessCategory: row.businessCategory,
          source: 'DISCOVERED',
          pipelineStage: 'NEW',
          dedupeKey: row.dedupeKey,
          phones: { create: row.phones.map((p, i) => ({ raw: p.raw, e164: p.e164, valid: p.valid, isPrimary: i === 0 })) },
          emails: { create: row.emails.map((address, i) => ({ address, isPrimary: i === 0 })) },
          consentLogs: {
            create: CHANNELS.map((channel) => ({ channel, state: 'UNKNOWN' as const, source: 'IMPORT_DEFAULT' as const })),
          },
        },
      });
      await tx.leadCandidate.update({ where: { id: candidateId }, data: { promotedDealerId: dealer.id } });
      await this.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          organizationId: this.orgId(),
          entityType: 'Dealer',
          entityId: dealer.id,
          action: AuditAction.LEAD_PROMOTED,
          metadata: { candidateId, discoveryRunId: candidate.discoveryRunId, sourceUrl: candidate.sourceUrl },
        },
        tx,
      );
      return { dealerId: dealer.id };
    });
  }

  async reject(candidateId: string, userId: string): Promise<void> {
    await this.load(candidateId);
    const { count } = await this.prisma.leadCandidate.updateMany({
      where: { id: candidateId, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedByUserId: userId, reviewedAt: new Date() },
    });
    if (count === 0) throw new ConflictException(`candidate ${candidateId} is not PENDING — it cannot be decided again`);
  }

  private async load(id: string): Promise<LeadCandidate> {
    const c = await this.prisma.leadCandidate.findFirst({ where: { id } });
    if (!c) throw new NotFoundException(`no lead candidate ${id}`);
    return c;
  }

  private leadOf(c: LeadCandidate): RawLead {
    return {
      businessName: c.businessName,
      contactPersonName: c.contactPersonName,
      phones: c.rawPhones,
      emails: c.rawEmails,
      address: c.address,
      city: c.city,
      state: c.state,
      category: c.category,
    };
  }
}
