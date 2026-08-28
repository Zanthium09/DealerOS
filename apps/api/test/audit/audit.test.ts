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
import { runAsPlatformAdmin, runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
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
  test('needs a context — the trail is not writable from nowhere (§1.3)', async () => {
    await assert.rejects(
      audit.record({
        actorType: 'USER',
        actorId: 'audit-user',
        organizationId: ORG,
        entityType: 'Dealer',
        entityId: DEALER,
        action: AuditAction.PIPELINE_STAGE_CHANGED,
      }),
      /tenancy/i,
    );
  });

  test('record() refuses another org row (§9A.3)', async () => {
    await assert.rejects(
      runWithOrg(ORG, async () =>
        audit.record({
          actorType: 'USER',
          actorId: 'audit-user',
          organizationId: OTHER_ORG,
          entityType: 'Dealer',
          entityId: 'forged',
          action: AuditAction.DRAFT_APPROVED,
        }),
      ),
      /tenancy/i,
    );
    assert.equal(await raw.auditEvent.count({ where: { entityId: 'forged' } }), 0);
  });

  // record() is the only legitimate writer (§1.5, §9, §9A.3). Everything above tests
  // the wrapper; this tests that the wrapper cannot be gone around. A nested write
  // through the `auditEvents` relation used to reach the table with an
  // attacker-chosen actorType and action, in the caller's own org, unattributed —
  // which is exactly the DRAFT_APPROVED forgery the trail exists to rule out.
  test('the auditEvents relation is not a second writer (§1.5, §9)', async () => {
    await assert.rejects(
      runWithOrg(ORG, async () =>
        scoped.organization.update({
          where: { id: ORG },
          data: {
            auditEvents: {
              create: {
                actorType: 'USER',
                actorId: 'the-owner',
                entityType: 'MessageDraft',
                entityId: 'forged-by-relation',
                action: AuditAction.DRAFT_APPROVED,
              },
            },
          } as never,
        }),
      ),
      /tenancy/i,
    );
    assert.equal(
      await raw.auditEvent.count({ where: { entityId: 'forged-by-relation' } }),
      0,
    );
  });

  test('round-trips every field', async () => {
    const written = await runWithOrg(ORG, async () => audit.record({
      actorType: 'USER',
      actorId: 'audit-user',
      organizationId: ORG,
      entityType: 'Dealer',
      entityId: DEALER,
      action: AuditAction.PIPELINE_STAGE_CHANGED,
      metadata: { from: 'NEW', to: 'CONTACTED' },
    }));

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
    const written = await runAsPlatformAdmin(async () =>
      audit.record({
        actorType: 'ADMIN',
        actorId: OTHER_ADMIN,
        organizationId: null,
        entityType: 'audit-platform',
        entityId: 'metrics',
        action: AuditAction.VIEWED_ORG_DATA,
      }),
    );
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
          await runWithOrg(ORG, async () =>
            audit.record(
              {
                actorType: 'SYSTEM',
                actorId: null,
                organizationId: ORG,
                entityType: 'Dealer',
                entityId: DEALER,
                action: AuditAction.PIPELINE_STAGE_CHANGED,
              },
              tx,
            ),
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
    runWithOrg(ORG, async () =>
      audit.record({
        actorType: 'ADMIN',
        actorId: OTHER_ADMIN,
        organizationId: ORG,
        entityType: 'Organization',
        entityId: ORG,
        action: AuditAction.ORGANIZATION_SUSPENDED,
      }),
    );

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

  // Consent is per channel (§4, §10.2, §13). This file used to claim §10.2 while
  // writing two EMAIL rows — which proves ordering, not independence. Nothing in the
  // suite touched WHATSAPP or CALL at all, so an email opt-out silently suppressing
  // WhatsApp would have shipped green.
  test('an EMAIL opt-out does not suppress WHATSAPP or CALL (§10.2, §13)', async () => {
    const dealerId = 'audit-dealer-channels';
    await raw.dealer.create({
      data: { id: dealerId, organizationId: ORG, businessName: 'Channel Co', source: 'MANUAL' },
    });
    for (const channel of ['EMAIL', 'WHATSAPP', 'CALL'] as const) {
      await raw.consentLog.create({
        data: { organizationId: ORG, dealerId, channel, state: 'OPTED_IN', source: 'IMPORT_DEFAULT' },
      });
    }
    // The opt-out arrives on EMAIL only.
    await raw.consentLog.create({
      data: {
        organizationId: ORG,
        dealerId,
        channel: 'EMAIL',
        state: 'OPTED_OUT',
        source: 'EXPLICIT_UNSUBSCRIBE',
      },
    });

    // Current state = most recent row per (dealerId, channel).
    const rows = await raw.consentLog.findMany({
      where: { dealerId },
      orderBy: { createdAt: 'asc' },
    });
    const current = new Map(rows.map((r) => [r.channel, r.state]));
    assert.equal(current.get('EMAIL'), 'OPTED_OUT');
    assert.equal(current.get('WHATSAPP'), 'OPTED_IN');
    assert.equal(current.get('CALL'), 'OPTED_IN');
    // The EMAIL opt-in is still in the history — the trail is append-only, not replaced.
    assert.equal(rows.filter((r) => r.channel === 'EMAIL').length, 2);
  });

  test('a second row supersedes the first instead of overwriting it (§4, append-only)', async () => {
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
    await runAsPlatformAdmin(async () => {
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
  });

  // This used to assert the leak: it called find({ organizationId: OTHER_ORG }) with no
  // context at all and asserted rows came back — which any implementation with zero
  // scoping would also pass. A tenant may read its OWN trail and nothing else.
  test('a tenant context reads its own org and is refused another', async () => {
    const { events } = await runWithOrg(ORG, async () => audit.find({ organizationId: ORG }));
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.organizationId === ORG));

    await assert.rejects(
      runWithOrg(ORG, async () => audit.find({ organizationId: OTHER_ORG })),
      /refusing/i,
    );
    // Not even by omitting the filter, and not by asking for the platform-wide rows.
    await assert.rejects(runWithOrg(ORG, async () => audit.find({})), /explicit where.organizationId/);
    await assert.rejects(runWithOrg(ORG, async () => audit.find({ organizationId: null })), /refusing/i);
    // And with no context at all, nothing is readable (§1.3).
    await assert.rejects(audit.find({ organizationId: OTHER_ORG }), /tenancy/i);
  });

  test('selects platform-wide events with organizationId null', async () => {
    const { events } = await runAsPlatformAdmin(async () =>
      audit.find({ organizationId: null, entityType: 'audit-platform' }),
    );
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
