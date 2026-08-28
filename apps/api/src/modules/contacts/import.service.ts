// M1 — §5.1. Two steps, because the mapping is interactive:
//
//   startBatch()  parse → detected headers + a SUGGESTED mapping, ImportBatch(MAPPING)
//   runBatch()    caller confirms the mapping and re-sends the file → rows imported
//
// `source` is mandatory at startBatch: §5.1 and §16.2 — how a list was built decides
// what outreach is defensible, and it cannot be reconstructed after the fact.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConsentChannel, DealerSource, ImportBatch, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { DedupService } from './dedup.service';
import { ColumnMapping, NormalizedRow, normalizeRow, suggestMapping } from './normalize';
import { parseFile } from './parse';

export type StartBatchInput = {
  filename: string;
  buffer: Buffer;
  source: DealerSource;
  createdByUserId?: string | null;
};

export type BatchPreview = {
  batchId: string;
  headers: string[];
  suggestedMapping: ColumnMapping;
  sampleRows: Record<string, string>[];
  rowCount: number;
};

export type ImportResult = {
  batchId: string;
  rowCount: number;
  createdCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** Fuzzy hits — created as their own Dealer AND flagged for review (§5.1). */
  flaggedCount: number;
};

const CHANNELS: ConsentChannel[] = ['EMAIL', 'WHATSAPP', 'CALL'];

@Injectable()
export class ImportService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly dedup: DedupService,
  ) {}

  /** The tenancy extension would inject this anyway; Prisma's types want it named. */
  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: contacts import has no org context (§1.3).');
    return id;
  }

  async startBatch(input: StartBatchInput): Promise<BatchPreview> {
    if (!input.source || !Object.values(DealerSource).includes(input.source)) {
      throw new BadRequestException(
        'source is mandatory per import batch (§5.1) and must be a DealerSource.',
      );
    }
    const { headers, rows } = await parseFile(input.filename, input.buffer);
    if (headers.length === 0) throw new BadRequestException('File has no header row.');

    const suggestedMapping = suggestMapping(headers);
    const batch = await this.prisma.importBatch.create({
      data: {
        organizationId: this.orgId(),
        filename: input.filename,
        source: input.source,
        columnMapping: suggestedMapping as object,
        status: 'MAPPING',
        rowCount: rows.length,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    return {
      batchId: batch.id,
      headers,
      suggestedMapping,
      sampleRows: rows.slice(0, 5),
      rowCount: rows.length,
    };
  }

  /** The confirmed mapping is persisted on the batch before a single row is written. */
  async runBatch(batchId: string, buffer: Buffer, mapping: ColumnMapping): Promise<ImportResult> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Import batch not found.');
    if (batch.status !== 'MAPPING') {
      throw new BadRequestException(`Batch ${batchId} is ${batch.status}, not MAPPING.`);
    }
    if (!mapping?.businessName) {
      throw new BadRequestException('Column mapping must map businessName.');
    }

    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { columnMapping: mapping as object, status: 'PROCESSING' },
    });

    try {
      const { rows } = await parseFile(batch.filename, buffer);
      const result = await this.importRows(batch, rows.map((r) => normalizeRow(r, mapping)));
      await this.prisma.importBatch.update({
        where: { id: batchId },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          rowCount: result.rowCount,
          createdCount: result.createdCount,
          duplicateCount: result.duplicateCount,
          invalidCount: result.invalidCount,
        },
      });
      return result;
    } catch (err) {
      await this.prisma.importBatch.update({
        where: { id: batchId },
        data: { status: 'FAILED', finishedAt: new Date(), error: String(err) },
      });
      throw err;
    }
  }

  private async importRows(batch: ImportBatch, rows: NormalizedRow[]): Promise<ImportResult> {
    const result: ImportResult = {
      batchId: batch.id,
      rowCount: rows.length,
      createdCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      flaggedCount: 0,
    };

    // ponytail: one row at a time. A dealer list is thousands of rows, not millions,
    // and each row's dedup depends on the rows before it — batching would need a
    // within-batch index to stay correct. Revisit if an import ever gets slow.
    for (const row of rows) {
      if (!row.businessName) {
        result.invalidCount += 1;
        continue;
      }

      const match = await this.dedup.findMatch(row);

      // Exact phone or email: the same business. Absorb the contact points it brought
      // and change NOTHING that already exists — an overwrite here is the silent
      // corruption §5.1 warns about.
      if (match?.confirmed) {
        await this.enrich(match.dealerId, row);
        await this.prisma.duplicateCandidate.create({
          data: {
            organizationId: batch.organizationId,
            importBatchId: batch.id,
            matchedDealerId: match.dealerId,
            incomingPayload: row as object,
            matchReason: match.reason,
            matchScore: match.score,
            status: 'MERGED',
          },
        });
        result.duplicateCount += 1;
        continue;
      }

      const dealer = await this.createDealer(batch, row);
      result.createdCount += 1;

      // §5.1/§10.1 — a fuzzy hit NEVER merges. Both rows exist; a human resolves them
      // through MergeService, which is reversible.
      if (match) {
        await this.prisma.duplicateCandidate.create({
          data: {
            organizationId: batch.organizationId,
            importBatchId: batch.id,
            matchedDealerId: match.dealerId,
            incomingPayload: { ...row, createdDealerId: dealer.id } as object,
            matchReason: match.reason,
            matchScore: match.score,
            status: 'PENDING',
          },
        });
        result.flaggedCount += 1;
      }
    }
    return result;
  }

  private async createDealer(batch: ImportBatch, row: NormalizedRow) {
    return this.prisma.dealer.create({
      data: {
        organizationId: batch.organizationId,
        businessName: row.businessName,
        contactPersonName: row.contactPersonName,
        region: row.region,
        city: row.city,
        state: row.state,
        businessCategory: row.businessCategory,
        source: batch.source,
        pipelineStage: 'NEW',
        dedupeKey: row.dedupeKey,
        phones: {
          create: row.phones.map((p, i) => ({
            raw: p.raw,
            e164: p.e164,
            // §5.1: unparseable is FLAGGED, not dropped. raw survives either way.
            valid: p.valid,
            isPrimary: i === 0,
          })),
        },
        emails: {
          create: row.emails.map((address, i) => ({
            address,
            isPrimary: i === 0,
          })),
        },
        // §5.1 + §1.6: importing a list is NOT consent. One row per channel, state
        // UNKNOWN, and ConsentLog is append-only so a wrong OPTED_IN here could never
        // be taken back.
        consentLogs: {
          create: CHANNELS.map((channel) => ({
            channel,
            state: 'UNKNOWN' as const,
            source: 'IMPORT_DEFAULT' as const,
          })),
        },
      },
    });
  }

  /** Additive only: contact points the matched dealer does not already have. */
  private async enrich(dealerId: string, row: NormalizedRow): Promise<void> {
    const [phones, emails] = await Promise.all([
      this.prisma.dealerPhone.findMany({ where: { dealerId } }),
      this.prisma.dealerEmail.findMany({ where: { dealerId } }),
    ]);
    const knownPhones = new Set(phones.map((p) => p.e164 ?? p.raw));
    const knownEmails = new Set(emails.map((e) => e.address));

    for (const p of row.phones) {
      if (knownPhones.has(p.e164 ?? p.raw)) continue;
      await this.prisma.dealerPhone.create({
        data: { organizationId: this.orgId(), dealerId, raw: p.raw, e164: p.e164, valid: p.valid },
      });
    }
    for (const address of row.emails) {
      if (knownEmails.has(address)) continue;
      await this.prisma.dealerEmail.create({
        data: { organizationId: this.orgId(), dealerId, address },
      });
    }
  }
}
