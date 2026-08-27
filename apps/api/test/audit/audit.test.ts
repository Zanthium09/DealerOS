// Audit log: what it records, how it is queried (§9A.3), and that the two
// append-only tables really are append-only in the database (§1.6, §4).
//
// Real Postgres, no mocks, throwaway database (test/run.mjs). The immutability
// triggers arrive with `prisma migrate deploy` like every other piece of schema —
// nothing here installs or removes them, which is the point: the test exercises the
// migration that production runs.
import '../support';
import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runAsPlatformAdmin, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditAction } from '../../src/core/audit/audit.actions';
import { AuditService } from '../../src/core/audit/audit.service';

const raw = new PrismaClient();
// The same client the module wires in production: tenancy-scoped, with AuditEvent
// classified as exempt from injection.
const scoped = withTenancy(new PrismaClient());
const audit = new AuditService(scoped as unknown as PrismaClient);

const ORG = 'audit-org-a';
const OTHER_ORG = 'audit-org-b';
const DEALER = 'audit-dealer';
const ADMIN = 'audit-admin';
const OTHER_ADMIN = 'audit-admin-b';

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG, name: 'Audit Co', slug: ORG },
      { id: OTHER_ORG, name: 'Other Co', slug: OTHER_ORG },
    ],
  });
  await raw.dealer.create({
    data: { id: DEALER, organizationId: ORG, businessName: 'A Traders', source: 'MANUAL' },
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('AuditService.record', () => {
  test('round-trips every field', async () => {
    const written = await audit.record({
      actorType: 'USER',
      actorId: 'audit-user',
      organizationId: ORG,
      entityType: 'Dealer',
      entityId: DEALER,
      action: AuditAction.PIPELINE_STAGE_CHANGED,
      metadata: { from: 'NEW', to: 'CONTACTED' },
    });

    const read = await raw.auditEvent.findUniqueOrThrow({ where: { id: written.id } });
    assert.equal(read.actorType, 'USER');
    assert.equal(read.actorId, 'audit-user');
    assert.equal(read.organizationId, ORG);
    assert.equal(read.entityType, 'Dealer');
    assert.equal(read.entityId, DEALER);
    assert.equal(read.action, 'PIPELINE_STAGE_CHANGED');
    assert.deepEqual(read.metadata, { from: 'NEW', to: 'CONTACTED' });
    assert.ok(read.createdAt instanceof Date);
  });

  test('records a platform-wide admin action with organizationId null (§9A.3)', async () => {
    const written = await audit.record({
      actorType: 'ADMIN',
      actorId: OTHER_ADMIN,
      organizationId: null,
      entityType: 'audit-platform',
      entityId: 'metrics',
      action: AuditAction.VIEWED_ORG_DATA,
    });
    assert.equal(
      (await raw.auditEvent.findUniqueOrThrow({ where: { id: written.id } })).organizationId,
      null,
    );
  });

  test('rolls the audit row back with the caller transaction', async () => {
    let id = '';
    await assert.rejects(
      raw.$transaction(async (tx) => {
        id = (
          await audit.record(
            {
              actorType: 'SYSTEM',
              actorId: null,
              organizationId: ORG,
              entityType: 'Dealer',
              entityId: DEALER,
              action: AuditAction.PIPELINE_STAGE_CHANGED,
            },
            tx,
          )
        ).id;
        throw new Error('caller failed after the audit write');
      }),
    );
    assert.equal(await raw.auditEvent.findUnique({ where: { id } }), null);
  });
});

describe('AuditEvent immutability', () => {
  const seed = () =>
    audit.record({
      actorType: 'ADMIN',
      actorId: OTHER_ADMIN,
      organizationId: ORG,
      entityType: 'Organization',
      entityId: ORG,
      action: AuditAction.ORGANIZATION_SUSPENDED,
    });

  test('rejects UPDATE via Prisma and via raw SQL', async () => {
    const { id } = await seed();
    await assert.rejects(
      raw.auditEvent.update({ where: { id }, data: { action: 'TAMPERED' } }),
      /immutable/,
    );
    await assert.rejects(
      raw.$executeRawUnsafe(`UPDATE "AuditEvent" SET action = 'TAMPERED' WHERE id = $1`, id),
      /immutable/,
    );
    assert.equal(
      (await raw.auditEvent.findUniqueOrThrow({ where: { id } })).action,
      'ORGANIZATION_SUSPENDED',
    );
  });

  test('rejects DELETE via Prisma and via raw SQL', async () => {
    const { id } = await seed();
    await assert.rejects(raw.auditEvent.delete({ where: { id } }), /immutable/);
    await assert.rejects(
      raw.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE id = $1`, id),
      /immutable/,
    );
    assert.ok(await raw.auditEvent.findUnique({ where: { id } }));
  });

  test('rejects TRUNCATE', async () => {
    await assert.rejects(raw.$executeRawUnsafe('TRUNCATE "AuditEvent"'), /immutable/);
  });
});

// §1.6, §4: consent history is the DPDP audit trail. A comment saying "append-only"
// is not enforcement, so this asserts the database refuses, the same three ways.
describe('ConsentLog immutability', () => {
  const seed = () =>
    raw.consentLog.create({
      data: {
        organizationId: ORG,
        dealerId: DEALER,
        channel: 'EMAIL',
        state: 'OPTED_IN',
        source: 'IMPORT_DEFAULT',
      },
    });

  test('rejects UPDATE via Prisma and via raw SQL', async () => {
    const { id } = await seed();
    await assert.rejects(
      raw.consentLog.update({ where: { id }, data: { state: 'OPTED_OUT' } }),
      /append-only/,
    );
    await assert.rejects(
      raw.$executeRawUnsafe(`UPDATE "ConsentLog" SET state = 'OPTED_OUT' WHERE id = $1`, id),
      /append-only/,
    );
    assert.equal((await raw.consentLog.findUniqueOrThrow({ where: { id } })).state, 'OPTED_IN');
  });

  test('rejects DELETE via Prisma and via raw SQL', async () => {
    const { id } = await seed();
    await assert.rejects(raw.consentLog.delete({ where: { id } }), /append-only/);
    await assert.rejects(
      raw.$executeRawUnsafe(`DELETE FROM "ConsentLog" WHERE id = $1`, id),
      /append-only/,
    );
    assert.ok(await raw.consentLog.findUnique({ where: { id } }));
  });

  test('rejects TRUNCATE', async () => {
    await assert.rejects(raw.$executeRawUnsafe('TRUNCATE "ConsentLog"'), /append-only/);
  });

  test('a second row supersedes the first instead of overwriting it (§10.2)', async () => {
    const first = await seed();
    const second = await raw.consentLog.create({
      data: {
        organizationId: ORG,
        dealerId: DEALER,
        channel: 'EMAIL',
        state: 'OPTED_OUT',
        source: 'EXPLICIT_UNSUBSCRIBE',
      },
    });
    const history = await raw.consentLog.findMany({
      where: { dealerId: DEALER, channel: 'EMAIL' },
      orderBy: { createdAt: 'asc' },
    });
    assert.ok(history.some((r) => r.id === first.id));
    assert.equal(history[history.length - 1].id, second.id);
  });
});

describe('AuditService.find', () => {
  before(async () => {
    await audit.record({
      actorType: 'ADMIN',
      actorId: ADMIN,
      organizationId: OTHER_ORG,
      entityType: 'Dealer',
      entityId: 'audit-viewed',
      action: AuditAction.VIEWED_ORG_DATA,
    });
    await audit.record({
      actorType: 'ADMIN',
      actorId: ADMIN,
      organizationId: ORG,
      entityType: 'Dealer',
      entityId: 'audit-viewed',
      action: AuditAction.VIEWED_ORG_DATA,
    });
  });

  test('scopes by organization', async () => {
    const { events } = await audit.find({ organizationId: OTHER_ORG });
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.organizationId === OTHER_ORG));
  });

  test('selects platform-wide events with organizationId null', async () => {
    const { events } = await audit.find({ organizationId: null, entityType: 'audit-platform' });
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.organizationId === null));
  });

  // The cross-org question §9A.3 exists to answer. It is deliberately only askable
  // from a PLATFORM context — a tenant one has to name its org.
  test('answers which admin viewed which org, when (§9A.3)', async () => {
    const { events } = await runAsPlatformAdmin(async () =>
      audit.find({
        actorType: 'ADMIN',
        actorId: ADMIN,
        action: AuditAction.VIEWED_ORG_DATA,
        from: new Date(Date.now() - 60_000),
      }),
    );
    assert.equal(events.length, 2);
    assert.deepEqual(new Set(events.map((e) => e.organizationId)), new Set([ORG, OTHER_ORG]));
  });

  test('filters by entity and time range, and paginates', async () => {
    await runAsPlatformAdmin(async () => {
      assert.equal(
        (await audit.find({ entityType: 'Dealer', entityId: 'audit-viewed' })).events.length,
        2,
      );
      assert.equal(
        (await audit.find({ entityId: 'audit-viewed', before: new Date(Date.now() - 60_000) }))
          .events.length,
        0,
      );

      const first = await audit.find({ entityId: 'audit-viewed', take: 1 });
      assert.equal(first.events.length, 1);
      assert.ok(first.nextCursor);
      const second = await audit.find({
        entityId: 'audit-viewed',
        take: 1,
        cursor: first.nextCursor!,
      });
      assert.equal(second.events.length, 1);
      assert.notEqual(second.events[0].id, first.events[0].id);
      assert.equal(second.nextCursor, null);
    });
  });
});
