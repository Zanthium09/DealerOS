import { Inject, Injectable } from '@nestjs/common';
import { ActorType, AuditEvent, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../tenancy/tenancy.module';
import { AuditAction } from './audit.actions';

/**
 * One write. `organizationId` is required-but-nullable on purpose: a platform-wide
 * admin action belongs to no org (§9A.3), and forcing the caller to say `null`
 * rather than letting them omit it means nobody writes an org-scoped event that
 * quietly lands unscoped.
 */
export type AuditRecord = {
  actorType: ActorType;
  /** null only for actorType SYSTEM. */
  actorId: string | null;
  /** null only for a platform-wide action with no single org (§9A.3). */
  organizationId: string | null;
  entityType: string;
  entityId: string;
  action: AuditAction;
  metadata?: Prisma.InputJsonValue;
};

export type AuditQuery = {
  /** Omit for no filter. Pass `null` to select platform-wide events only. */
  organizationId?: string | null;
  entityType?: string;
  entityId?: string;
  actorType?: ActorType;
  actorId?: string;
  action?: AuditAction | AuditAction[];
  /** Inclusive lower / exclusive upper bound on createdAt. */
  from?: Date;
  before?: Date;
  /** Page size, default 50, max 200. */
  take?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
};

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Writes the event. THROWS if the write fails — see the module doc comment: an
   * audit write that fails must take the operation down with it, not disappear.
   *
   * Pass `tx` to write inside the caller's transaction so the audited change and
   * its audit row commit or roll back together (§4 pipeline transitions).
   */
  record(event: AuditRecord, tx?: Prisma.TransactionClient): Promise<AuditEvent> {
    return (tx ?? this.prisma).auditEvent.create({ data: event });
  }

  /** §9A.3: "which admin viewed which org's data, when". */
  async find(query: AuditQuery = {}): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
    const take = Math.min(query.take ?? 50, 200);
    const where: Prisma.AuditEventWhereInput = {
      ...('organizationId' in query ? { organizationId: query.organizationId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action
        ? { action: Array.isArray(query.action) ? { in: query.action } : query.action }
        : {}),
      ...(query.from || query.before
        ? { createdAt: { ...(query.from && { gte: query.from }), ...(query.before && { lt: query.before }) } }
        : {}),
    };

    const events = await this.prisma.auditEvent.findMany({
      where,
      // id breaks createdAt ties so the cursor never skips or repeats a row.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const page = events.slice(0, take);
    return { events: page, nextCursor: events.length > take ? page[page.length - 1].id : null };
  }
}
