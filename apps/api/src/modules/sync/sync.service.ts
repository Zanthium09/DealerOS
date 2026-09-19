// §5.5 — order & payment sync. Shared infrastructure: M5/M6/M7/M8 read what this writes.
//
// v1 is CSV/XLSX import regardless of the accounting system (§16.1), so this is a file
// importer with a visible cadence (SyncBatch → data freshness, §14), not a live sync.
//
// Imports run in the background: the request returns a batch id at once and the caller
// polls it. A few thousand rows means thousands of sequential round trips, which is
// longer than a proxy will hold a request open — the contacts importer needed client-side
// chunking for exactly this. Chunking cannot work here (an order's line items may span a
// chunk boundary), so the work is detached from the request instead.
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient, SyncBatch, SyncKind } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { parseFile, Row } from '../contacts/parse';
import { ageingBucketFor } from './ageing';
import { cellOf, detectMapping, ORDER_FIELDS, PAYMENT_FIELDS, PRODUCT_FIELDS } from './columns';
import { DealerResolver } from './dealer-resolver';
import { parseDate, parseMoney } from './parse-values';

type Counters = {
  created: number;
  updated: number;
  unmatched: number;
  invalid: number;
  errors: { row: number; reason: string }[];
};
const newCounters = (): Counters => ({ created: 0, updated: 0, unmatched: 0, invalid: 0, errors: [] });
const MAX_LOGGED_ERRORS = 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

function note(c: Counters, kind: 'unmatched' | 'invalid', row: number, reason: string) {
  c[kind]++;
  if (c.errors.length < MAX_LOGGED_ERRORS) c.errors.push({ row, reason });
}

export type ImportKind = 'orders' | 'payments' | 'products';
const KIND: Record<ImportKind, SyncKind> = { orders: 'ORDERS', payments: 'PAYMENTS', products: 'PRODUCTS' };

type Mapping = Record<string, string | undefined>;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: sync has no org context (§1.3).');
    return id;
  }

  // ---- entry point ---------------------------------------------------------------

  async start(input: {
    kind: ImportKind;
    filename: string;
    buffer: Buffer;
    mapping?: Record<string, string>;
    userId?: string | null;
  }): Promise<{ batchId: string; rowCount: number; mapping: Mapping }> {
    const { headers, rows } = await parseFile(input.filename, input.buffer).catch((err) => {
      throw new BadRequestException(`could not read ${input.filename}: ${err instanceof Error ? err.message : err}`);
    });
    if (rows.length === 0) throw new BadRequestException('the file has no data rows');

    const mapping = this.mappingFor(input.kind, headers, input.mapping);
    const batch = await this.prisma.syncBatch.create({
      data: {
        organizationId: this.orgId(),
        kind: KIND[input.kind],
        filename: input.filename,
        rowCount: rows.length,
        createdByUserId: input.userId ?? null,
      },
    });

    // Detached on purpose — see the file header. AsyncLocalStorage carries the org
    // context into the continuation, so every query below is still tenant-scoped.
    void this.run(input.kind, batch.id, rows, mapping).catch(async (err) => {
      this.logger.error(`sync ${batch.id} failed: ${err instanceof Error ? err.stack : err}`);
      await this.prisma.syncBatch
        .update({
          where: { id: batch.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errors: [{ row: 0, reason: err instanceof Error ? err.message : String(err) }],
          },
        })
        .catch(() => {});
    });
    return { batchId: batch.id, rowCount: rows.length, mapping };
  }

  private mappingFor(kind: ImportKind, headers: string[], override?: Record<string, string>): Mapping {
    const spec = kind === 'orders' ? ORDER_FIELDS : kind === 'payments' ? PAYMENT_FIELDS : PRODUCT_FIELDS;
    const mapping = detectMapping(headers, spec as never, (override ?? {}) as never) as Mapping;
    const need: Record<ImportKind, string[]> = {
      orders: ['orderDate'],
      payments: ['invoiceRef', 'amount', 'dueDate'],
      products: ['sku', 'name', 'unitPrice'],
    };
    const missing = need[kind].filter((f) => !mapping[f]);
    if (kind !== 'products' && !mapping.dealerName && !mapping.phone && !mapping.email) {
      missing.push('dealerName (or phone/email)');
    }
    if (missing.length) {
      throw new BadRequestException(
        `can't find column(s) for: ${missing.join(', ')}. Headers in the file: ${headers.join(', ')}. ` +
          `Pass "mapping" to name them explicitly.`,
      );
    }
    return mapping;
  }

  private async run(kind: ImportKind, batchId: string, rows: Row[], mapping: Mapping) {
    const c = newCounters();
    if (kind === 'orders') await this.runOrders(batchId, rows, mapping, c);
    else if (kind === 'payments') await this.runPayments(batchId, rows, mapping, c);
    else await this.runProducts(rows, mapping, c);

    // Every sync recalculates ageing (§5.5) — a payment file can move an old invoice
    // out of a bucket, and an order-only file still moves time forward.
    if (kind !== 'products') await this.recalculateAgeing();

    await this.prisma.syncBatch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        createdCount: c.created,
        updatedCount: c.updated,
        unmatchedCount: c.unmatched,
        invalidCount: c.invalid,
        errors: c.errors,
      },
    });
  }

  // ---- orders --------------------------------------------------------------------

  private async runOrders(batchId: string, rows: Row[], m: Mapping, c: Counters) {
    const resolver = new DealerResolver(this.prisma);
    const groups = new Map<string, { row: Row; idx: number }[]>();
    rows.forEach((row, idx) => {
      const ref = cellOf(row, m.orderRef);
      const key = ref || `row:${idx}`;
      const list = groups.get(key) ?? [];
      list.push({ row, idx });
      groups.set(key, list);
    });

    for (const [key, members] of groups) {
      const first = members[0];
      const rowNo = first.idx + 2; // row 1 is the header
      const externalRef = key.startsWith('row:') ? null : key;

      const date = parseDate(cellOf(first.row, m.orderDate));
      if (!date) {
        note(c, 'invalid', rowNo, `unreadable date "${cellOf(first.row, m.orderDate)}"`);
        continue;
      }

      const ref = {
        name: cellOf(first.row, m.dealerName),
        phone: cellOf(first.row, m.phone),
        email: cellOf(first.row, m.email),
      };
      const dealerId = await resolver.resolve(ref);
      if (!dealerId) {
        note(c, 'unmatched', rowNo, `no exact dealer match for "${ref.name || ref.phone || ref.email}"`);
        continue;
      }

      const lines = members.flatMap(({ row }) => {
        const qty = parseMoney(cellOf(row, m.quantity));
        const price = parseMoney(cellOf(row, m.unitPrice));
        const sku = cellOf(row, m.sku);
        const productName = cellOf(row, m.productName) || sku;
        if (qty === null || price === null || !(sku || productName)) return [];
        return [{ sku: sku || productName, productName, quantity: qty, unitPrice: price, lineTotal: round2(qty * price) }];
      });

      let total: number | null;
      if (lines.length > 0) {
        total = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
      } else {
        const values = members
          .map(({ row }) => parseMoney(cellOf(row, m.total)))
          .filter((v): v is number => v !== null);
        if (values.length === 0) total = null;
        // ponytail: a repeated identical value across an order's rows reads as "the order
        // total, repeated", not N equal line amounts. Wrong only for per-line files with
        // no qty/rate columns and identical amounts — name the columns via `mapping`.
        else if (new Set(values).size === 1 && values.length > 1) total = values[0];
        else total = round2(values.reduce((s, v) => s + v, 0));
      }
      if (total === null) {
        note(c, 'invalid', rowNo, 'no readable order total or quantity × rate');
        continue;
      }
      if (total <= 0) {
        // Credit notes / returns would silently reduce a dealer's revenue history.
        note(c, 'invalid', rowNo, `non-positive total ${total} (credit note or return?) — not imported`);
        continue;
      }

      const data = { dealerId, orderDate: date, totalValue: total, source: 'CSV_IMPORT' as const, syncBatchId: batchId };
      const existing = externalRef ? await this.prisma.order.findFirst({ where: { externalRef } }) : null;
      if (existing) {
        await this.prisma.order.update({
          where: { id: existing.id },
          data: { ...data, lineItems: { deleteMany: {}, create: lines } } as never,
        });
        c.updated++;
      } else {
        await this.prisma.order.create({
          data: { ...data, externalRef, lineItems: { create: lines } } as never,
        });
        c.created++;
      }
    }
  }

  // ---- payments ------------------------------------------------------------------

  private async runPayments(batchId: string, rows: Row[], m: Mapping, c: Counters) {
    const resolver = new DealerResolver(this.prisma);
    const syncedAt = new Date();

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const rowNo = idx + 2;
      const invoiceRef = cellOf(row, m.invoiceRef);
      const amount = parseMoney(cellOf(row, m.amount));
      const dueDate = parseDate(cellOf(row, m.dueDate));
      if (!invoiceRef || amount === null || !dueDate) {
        note(
          c,
          'invalid',
          rowNo,
          !invoiceRef
            ? 'missing invoice ref'
            : amount === null
              ? `unreadable amount "${cellOf(row, m.amount)}"`
              : `unreadable due date "${cellOf(row, m.dueDate)}"`,
        );
        continue;
      }
      const paidAmount = parseMoney(cellOf(row, m.paidAmount)) ?? 0;
      const paidDate = parseDate(cellOf(row, m.paidDate));

      const ref = { name: cellOf(row, m.dealerName), phone: cellOf(row, m.phone), email: cellOf(row, m.email) };
      const dealerId = await resolver.resolve(ref);
      if (!dealerId) {
        note(c, 'unmatched', rowNo, `no exact dealer match for "${ref.name || ref.phone || ref.email}"`);
        continue;
      }

      const data = {
        dealerId,
        amount,
        dueDate,
        paidAmount,
        paidDate: paidAmount > 0 ? paidDate : null,
        ageingBucket: ageingBucketFor({ dueDate, amount, paidAmount }),
        // Stamped for every row in the file, changed or not: what §10.4 needs to know is
        // "was this invoice seen in the latest sync", not "did it change".
        lastSyncedAt: syncedAt,
        syncBatchId: batchId,
      };
      const existing = await this.prisma.paymentLedgerEntry.findFirst({ where: { invoiceRef } });
      if (existing) {
        await this.prisma.paymentLedgerEntry.update({ where: { id: existing.id }, data: data as never });
        c.updated++;
      } else {
        await this.prisma.paymentLedgerEntry.create({ data: { ...data, invoiceRef } as never });
        c.created++;
      }
    }
  }

  // ---- products ------------------------------------------------------------------

  private async runProducts(rows: Row[], m: Mapping, c: Counters) {
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const rowNo = idx + 2;
      const sku = cellOf(row, m.sku);
      const name = cellOf(row, m.name);
      const unitPrice = parseMoney(cellOf(row, m.unitPrice));
      if (!sku || !name || unitPrice === null) {
        note(
          c,
          'invalid',
          rowNo,
          !sku ? 'missing sku' : !name ? 'missing name' : `unreadable price "${cellOf(row, m.unitPrice)}"`,
        );
        continue;
      }
      const activeCell = cellOf(row, m.active).toLowerCase();
      const data = {
        name,
        unitPrice,
        category: cellOf(row, m.category) || null,
        active: activeCell ? !['0', 'no', 'false', 'inactive', 'n'].includes(activeCell) : true,
      };
      const existing = await this.prisma.product.findFirst({ where: { sku } });
      if (existing) {
        await this.prisma.product.update({ where: { id: existing.id }, data });
        c.updated++;
      } else {
        await this.prisma.product.create({ data: { ...data, sku } as never });
        c.created++;
      }
    }
  }

  // ---- ageing --------------------------------------------------------------------

  /**
   * Re-derives the bucket for every unpaid invoice from today's date. Buckets are a
   * function of time, so they go stale between syncs; collections (M7) calls this
   * before it reads them. Idempotent.
   */
  async recalculateAgeing(now: Date = new Date()): Promise<{ moved: number }> {
    const entries = await this.prisma.paymentLedgerEntry.findMany({
      select: { id: true, amount: true, paidAmount: true, dueDate: true, ageingBucket: true },
    });
    const byBucket = new Map<string, string[]>();
    for (const e of entries) {
      const next = ageingBucketFor(
        { dueDate: e.dueDate, amount: Number(e.amount), paidAmount: Number(e.paidAmount) },
        now,
      );
      if (next !== e.ageingBucket) {
        const ids = byBucket.get(next) ?? [];
        ids.push(e.id);
        byBucket.set(next, ids);
      }
    }
    let moved = 0;
    for (const [bucket, ids] of byBucket) {
      const res = await this.prisma.paymentLedgerEntry.updateMany({
        where: { id: { in: ids } },
        data: { ageingBucket: bucket as never },
      });
      moved += res.count;
    }
    return { moved };
  }

  // ---- reads ---------------------------------------------------------------------

  getBatch(id: string): Promise<SyncBatch | null> {
    return this.prisma.syncBatch.findFirst({ where: { id } });
  }

  listBatches(): Promise<SyncBatch[]> {
    return this.prisma.syncBatch.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
  }

  /** §14 — last COMPLETED sync per kind. null = never synced. */
  async freshness(): Promise<Record<'orders' | 'payments' | 'products', string | null>> {
    const out = { orders: null, payments: null, products: null } as Record<'orders' | 'payments' | 'products', string | null>;
    for (const k of ['ORDERS', 'PAYMENTS', 'PRODUCTS'] as SyncKind[]) {
      const last = await this.prisma.syncBatch.findFirst({
        where: { kind: k, status: 'COMPLETED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      });
      out[k.toLowerCase() as 'orders' | 'payments' | 'products'] = last?.finishedAt?.toISOString() ?? null;
    }
    return out;
  }

  /**
   * §14 dealer scorecard. Computed on read from Order/PaymentLedgerEntry rather than
   * stored: a stored scorecard is one more thing that can disagree with the rows it
   * summarises, and "recalculated on every sync" is exactly what reading live gives.
   */
  async scorecard(dealerId: string, now: Date = new Date()) {
    const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const [orders, recent, ledger, inbound] = await Promise.all([
      this.prisma.order.aggregate({
        where: { dealerId },
        _count: { _all: true },
        _sum: { totalValue: true },
        _max: { orderDate: true },
        _min: { orderDate: true },
      }),
      this.prisma.order.count({ where: { dealerId, orderDate: { gte: since90 } } }),
      this.prisma.paymentLedgerEntry.findMany({
        where: { dealerId },
        select: { amount: true, paidAmount: true, ageingBucket: true, dueDate: true, paidDate: true },
      }),
      this.prisma.interactionEvent.count({ where: { dealerId, direction: 'INBOUND', createdAt: { gte: since90 } } }),
    ]);

    const count = orders._count._all;
    const revenue = Number(orders._sum.totalValue ?? 0);
    const lastOrder = orders._max.orderDate;
    const owed = (e: { amount: unknown; paidAmount: unknown }) => Math.max(0, Number(e.amount) - Number(e.paidAmount));
    const outstanding = ledger.reduce((s, e) => s + owed(e), 0);
    const overdue = ledger.filter((e) => e.ageingBucket !== 'CURRENT').reduce((s, e) => s + owed(e), 0);
    // Payment behaviour: average days from due date to payment, over invoices actually paid.
    const paid = ledger.filter((e) => e.paidDate && Number(e.paidAmount) >= Number(e.amount));
    const avgDaysToPay = paid.length
      ? Math.round(paid.reduce((s, e) => s + (e.paidDate!.getTime() - e.dueDate.getTime()) / 86_400_000, 0) / paid.length)
      : null;

    return {
      dealerId,
      orderCount: count,
      totalRevenue: round2(revenue),
      averageOrderValue: count ? round2(revenue / count) : null,
      firstOrderDate: orders._min.orderDate,
      lastOrderDate: lastOrder,
      daysSinceLastOrder: lastOrder ? Math.floor((now.getTime() - lastOrder.getTime()) / 86_400_000) : null,
      ordersLast90Days: recent,
      outstanding: round2(outstanding),
      overdue: round2(overdue),
      // Positive = pays late on average, negative = early.
      averageDaysToPay: avgDaysToPay,
      inboundMessagesLast90Days: inbound,
    };
  }

  /** Top dealers by revenue, with outstanding balance alongside. */
  async topDealers(take = 25) {
    const grouped = await this.prisma.order.groupBy({
      by: ['dealerId'],
      _sum: { totalValue: true },
      _count: { _all: true },
      _max: { orderDate: true },
      orderBy: { _sum: { totalValue: 'desc' } },
      take: Math.min(take, 200),
    });
    const ids = grouped.map((g) => g.dealerId);
    const [dealers, ledger] = await Promise.all([
      this.prisma.dealer.findMany({
        where: { id: { in: ids } },
        select: { id: true, businessName: true, city: true, pipelineStage: true },
      }),
      this.prisma.paymentLedgerEntry.findMany({
        where: { dealerId: { in: ids } },
        select: { dealerId: true, amount: true, paidAmount: true },
      }),
    ]);
    const byId = new Map(dealers.map((d) => [d.id, d]));
    const owed = new Map<string, number>();
    for (const e of ledger) {
      owed.set(e.dealerId, (owed.get(e.dealerId) ?? 0) + Math.max(0, Number(e.amount) - Number(e.paidAmount)));
    }
    return grouped.map((g) => ({
      dealerId: g.dealerId,
      businessName: byId.get(g.dealerId)?.businessName ?? g.dealerId,
      city: byId.get(g.dealerId)?.city ?? null,
      pipelineStage: byId.get(g.dealerId)?.pipelineStage ?? null,
      orderCount: g._count._all,
      totalRevenue: round2(Number(g._sum.totalValue ?? 0)),
      lastOrderDate: g._max.orderDate,
      outstanding: round2(owed.get(g.dealerId) ?? 0),
    }));
  }
}
