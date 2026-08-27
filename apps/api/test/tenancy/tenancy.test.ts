// Integration tests for tenant scoping (§1.3, §9A.2, §13 — first money path).
// Real Postgres, real Prisma. Mocking the ORM here would test nothing.
//   pnpm test  (provisions a throwaway database — see test/run.mjs)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import '../support';
import {
  AUDIT_MODELS,
  runWithOrg,
  runAsPlatformAdmin,
  getOrgId,
  withTenancy,
  EXEMPT_MODELS,
  SELF_SCOPED_MODELS,
  TENANT_MODELS,
} from '../../src/core/tenancy/tenancy';

// Unscoped client — setup only. Never used inside an assertion about scoping.
const raw = new PrismaClient();
const db = withTenancy(new PrismaClient());

const ORG_A = 'test-org-a';
const ORG_B = 'test-org-b';
const DEALER_A = 'test-dealer-a';
const DEALER_B = 'test-dealer-b';
const ADMIN = 'test-admin-user';

// No cleanup anywhere in this file: the database is thrown away at the end of the run
// (test/run.mjs). AuditEvent and ConsentLog could not be cleaned up anyway — they are
// append-only in the schema now.
before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Org A', slug: ORG_A },
      { id: ORG_B, name: 'Org B', slug: ORG_B },
    ],
  });
  await raw.dealer.createMany({
    data: [
      { id: DEALER_A, organizationId: ORG_A, businessName: 'A Traders', source: 'MANUAL' },
      { id: DEALER_B, organizationId: ORG_B, businessName: 'B Traders', source: 'MANUAL' },
    ],
  });
  await raw.adminUser.create({
    data: { id: ADMIN, email: 'admin@test.local', role: 'PLATFORM_ADMIN' },
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('no org context fails closed', () => {
  test('getOrgId is undefined outside a context', () => {
    assert.equal(getOrgId(), undefined);
  });

  test('read/write on a tenant model throws rather than leaking', async () => {
    await assert.rejects(() => db.dealer.findMany(), /tenancy/i);
    await assert.rejects(() => db.dealer.findFirst(), /tenancy/i);
    await assert.rejects(() => db.dealer.findUnique({ where: { id: DEALER_A } }), /tenancy/i);
    await assert.rejects(() => db.dealer.count(), /tenancy/i);
    await assert.rejects(
      () => db.dealer.create({ data: { businessName: 'x', source: 'MANUAL' } as never }),
      /tenancy/i,
    );
    await assert.rejects(
      () => db.dealer.update({ where: { id: DEALER_A }, data: { businessName: 'x' } }),
      /tenancy/i,
    );
    await assert.rejects(() => db.dealer.delete({ where: { id: DEALER_A } }), /tenancy/i);
    await assert.rejects(() => db.dealer.deleteMany({}), /tenancy/i);
  });

  // Every tenant table, not just Dealer. A table added later without scoping fails here.
  for (const model of TENANT_MODELS) {
    test(`${model}.findMany throws with no org context`, async () => {
      const delegate = (db as never as Record<string, { findMany: () => Promise<unknown> }>)[
        model.charAt(0).toLowerCase() + model.slice(1)
      ];
      await assert.rejects(() => delegate.findMany(), /tenancy/i);
    });
  }

  test('every model in the schema is classified — no silent new table', () => {
    const classified = new Set([
      ...TENANT_MODELS,
      ...SELF_SCOPED_MODELS,
      ...EXEMPT_MODELS,
      ...AUDIT_MODELS,
    ]);
    const unclassified = Prisma.dmmf.datamodel.models
      .map((m) => m.name)
      .filter((name) => !classified.has(name));
    assert.deepEqual(unclassified, []);
  });

  test('the tenant table list is derived from the schema, not hand-written', () => {
    assert.ok(TENANT_MODELS.includes('Dealer'));
    assert.ok(TENANT_MODELS.includes('DealerPhone'));
    assert.ok(TENANT_MODELS.includes('ConsentLog'));
    assert.ok(TENANT_MODELS.includes('User'));
    assert.ok(!TENANT_MODELS.includes('AdminUser'));
    // Has an organizationId, still not a tenant table — see AUDIT_MODELS (§9A.3).
    assert.ok(!TENANT_MODELS.includes('AuditEvent'));
    assert.deepEqual(AUDIT_MODELS, ['AuditEvent']);
  });
});

describe('org A cannot touch org B rows', () => {
  test('findUnique with a correct org B id yields nothing', async () => {
    const found = await runWithOrg(ORG_A, async () => await db.dealer.findUnique({ where: { id: DEALER_B } }));
    assert.equal(found, null);
  });

  test('findUniqueOrThrow with a correct org B id throws', async () => {
    await assert.rejects(() =>
      runWithOrg(ORG_A, async () => await db.dealer.findUniqueOrThrow({ where: { id: DEALER_B } })),
    );
  });

  test('findMany/count sees only its own org', async () => {
    const rows = await runWithOrg(ORG_A, async () => await db.dealer.findMany());
    assert.deepEqual(
      rows.map((r) => r.id),
      [DEALER_A],
    );
    assert.equal(await runWithOrg(ORG_A, async () => await db.dealer.count()), 1);
  });

  // Not silently rewritten to org A: rewriting would turn a deleteMany aimed at org B
  // into a deleteMany of org A's own rows.
  test('a where clause naming org B is refused, not rewritten', async () => {
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.dealer.findMany({ where: { organizationId: ORG_B } })),
      /refusing/i,
    );
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.dealer.deleteMany({ where: { organizationId: ORG_B } })),
      /refusing/i,
    );
    assert.ok(await raw.dealer.findUnique({ where: { id: DEALER_A } }));
  });

  test('a where clause naming its own org is allowed', async () => {
    const rows = await runWithOrg(ORG_A, async () =>
      await db.dealer.findMany({ where: { organizationId: ORG_A } }),
    );
    assert.deepEqual(rows.map((r) => r.id), [DEALER_A]);
  });

  test('update on org B id does not change org B data', async () => {
    await assert.rejects(() =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.update({ where: { id: DEALER_B }, data: { businessName: 'HACKED' } }),
      ),
    );
    await runWithOrg(ORG_A, async () =>
      await db.dealer.updateMany({ where: { id: DEALER_B }, data: { businessName: 'HACKED' } }),
    );
    const b = await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_B } });
    assert.equal(b.businessName, 'B Traders');
  });

  test('delete on org B id does not remove org B data', async () => {
    await assert.rejects(() =>
      runWithOrg(ORG_A, async () => await db.dealer.delete({ where: { id: DEALER_B } })),
    );
    const res = await runWithOrg(ORG_A, async () =>
      await db.dealer.deleteMany({ where: { id: DEALER_B } }),
    );
    assert.equal(res.count, 0);
    assert.ok(await raw.dealer.findUnique({ where: { id: DEALER_B } }));
  });

  test('Organization itself is scoped to the context org', async () => {
    const orgs = await runWithOrg(ORG_A, async () => await db.organization.findMany());
    assert.deepEqual(
      orgs.map((o) => o.id),
      [ORG_A],
    );
    // Organization is scoped on its own primary key, so asking for org B's row by id is
    // a scope conflict — refused rather than quietly answered with org A's row.
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.organization.findUnique({ where: { id: ORG_B } })),
      /refusing/i,
    );
    const own = await runWithOrg(ORG_A, async () => await db.organization.findUnique({ where: { id: ORG_A } }));
    assert.equal(own?.id, ORG_A);
  });
});

describe('writes are forced into the context org', () => {
  test('create overrides a foreign organizationId in data', async () => {
    const created = await runWithOrg(ORG_A, async () =>
      await db.dealer.create({
        data: { organizationId: ORG_B, businessName: 'Forced', source: 'MANUAL' } as never,
      }),
    );
    assert.equal(created.organizationId, ORG_A);
    await raw.dealer.delete({ where: { id: created.id } });
  });

  test('createMany overrides a foreign organizationId in every row', async () => {
    await runWithOrg(ORG_A, async () =>
      await db.dealer.createMany({
        data: [
          { organizationId: ORG_B, businessName: 'M1', source: 'MANUAL' },
          { businessName: 'M2', source: 'MANUAL' } as never,
        ],
      }),
    );
    const rows = await raw.dealer.findMany({ where: { businessName: { in: ['M1', 'M2'] } } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.organizationId === ORG_A));
    await raw.dealer.deleteMany({ where: { businessName: { in: ['M1', 'M2'] } } });
  });

  test('update cannot move a row into another org', async () => {
    await runWithOrg(ORG_A, async () =>
      await db.dealer.update({
        where: { id: DEALER_A },
        data: { organizationId: ORG_B } as never,
      }),
    );
    const a = await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_A } });
    assert.equal(a.organizationId, ORG_A);
  });

  test('upsert is scoped on both branches', async () => {
    const up = await runWithOrg(ORG_A, async () =>
      await db.dealer.upsert({
        where: { id: 'test-upsert-1' },
        create: { id: 'test-upsert-1', organizationId: ORG_B, businessName: 'U', source: 'MANUAL' } as never,
        update: { businessName: 'U2' },
      }),
    );
    assert.equal(up.organizationId, ORG_A);
    await raw.dealer.delete({ where: { id: 'test-upsert-1' } });
  });
});

describe('PLATFORM context (§9A.2)', () => {
  test('yields no tenant rows through this layer', async () => {
    await assert.rejects(() => runAsPlatformAdmin(async () => await db.dealer.findMany()), /platform/i);
    await assert.rejects(() => runAsPlatformAdmin(async () => await db.dealer.count()), /platform/i);
    await assert.rejects(
      () => runAsPlatformAdmin(async () => await db.dealer.findUnique({ where: { id: DEALER_A } })),
      /platform/i,
    );
  });

  test('does not expose an org id', async () => {
    await runAsPlatformAdmin(async () => {
      assert.equal(getOrgId(), undefined);
    });
  });

  test('AdminUser is still reachable under a platform context', async () => {
    const admins = await runAsPlatformAdmin(async () => await db.adminUser.findMany());
    assert.ok(admins.some((a) => a.id === ADMIN));
  });
});

describe('AdminUser exemption (explicit allowlist)', () => {
  test('queries work with no org context at all', async () => {
    const found = await db.adminUser.findUnique({ where: { id: ADMIN } });
    assert.equal(found?.email, 'admin@test.local');
    assert.deepEqual(EXEMPT_MODELS, ['AdminUser']);
  });
});

describe('context plumbing', () => {
  test('runWithOrg nests and restores', () => {
    assert.equal(getOrgId(), undefined);
    runWithOrg(ORG_A, () => {
      assert.equal(getOrgId(), ORG_A);
      runWithOrg(ORG_B, () => assert.equal(getOrgId(), ORG_B));
      runAsPlatformAdmin(() => assert.equal(getOrgId(), undefined));
      assert.equal(getOrgId(), ORG_A);
    });
    assert.equal(getOrgId(), undefined);
  });

  // Prisma promises are lazy: the query is built when it is awaited, not when it is
  // created. A promise built inside a context but awaited outside one therefore has no
  // scope — and fails closed rather than running unscoped.
  test('a query awaited outside its context throws', async () => {
    const escaped = runWithOrg(ORG_A, () => db.dealer.findMany());
    await assert.rejects(() => escaped, /tenancy/i);
  });

  test('context survives an await boundary', async () => {
    await runWithOrg(ORG_A, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(getOrgId(), ORG_A);
    });
  });
});

// §9A.3 — AuditEvent is classified on its own: never org-injected, because
// AuditService.record() passes organizationId explicitly and a platform-wide row's
// null must survive being written from inside a tenant request.
describe('AuditEvent is exempt from injection (§9A.3)', () => {
  test('a platform-wide row is written and read back while a tenant context is active', async () => {
    const written = await runWithOrg(ORG_A, async () =>
      await db.auditEvent.create({
        data: {
          organizationId: null,
          actorType: 'ADMIN',
          actorId: ADMIN,
          entityType: 'Platform',
          entityId: 'tenancy-metrics',
          action: 'VIEWED_ORG_DATA',
        },
      }),
    );
    // Not rewritten to ORG_A — that is the whole point.
    assert.equal(written.organizationId, null);

    const read = await runWithOrg(ORG_A, async () =>
      await db.auditEvent.findMany({ where: { organizationId: null, entityId: 'tenancy-metrics' } }),
    );
    assert.deepEqual(read.map((e) => e.id), [written.id]);
  });

  test('a tenant-context read must name the org — nothing is guessed', async () => {
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.findMany()),
      /explicit where.organizationId/,
    );
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.count({})),
      /explicit where.organizationId/,
    );
    const scoped = await runWithOrg(ORG_A, async () =>
      await db.auditEvent.findMany({ where: { organizationId: ORG_A } }),
    );
    assert.ok(scoped.every((e) => e.organizationId === ORG_A));
  });

  test('a PLATFORM context may read across orgs — that is what the trail is for', async () => {
    await runWithOrg(ORG_B, async () =>
      await db.auditEvent.create({
        data: {
          organizationId: ORG_B,
          actorType: 'ADMIN',
          actorId: ADMIN,
          entityType: 'Dealer',
          entityId: DEALER_B,
          action: 'VIEWED_ORG_DATA',
        },
      }),
    );
    const all = await runAsPlatformAdmin(async () => await db.auditEvent.findMany());
    const orgs = new Set(all.map((e) => e.organizationId));
    assert.ok(orgs.has(null));
    assert.ok(orgs.has(ORG_B));
  });
});
