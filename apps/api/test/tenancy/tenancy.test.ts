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
const USER_A = 'test-user-a';
const USER_B = 'test-user-b';
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
  await raw.user.createMany({
    data: [
      {
        id: USER_A,
        organizationId: ORG_A,
        email: 'owner-a@test.local',
        name: 'Owner A',
        passwordHash: 'hash-a',
        role: 'OWNER',
      },
      {
        id: USER_B,
        organizationId: ORG_B,
        email: 'owner-b@test.local',
        name: 'Victim Owner zzzx',
        passwordHash: 'hash-b-secret',
        role: 'OWNER',
      },
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
    // Create branch.
    const created = await runWithOrg(ORG_A, async () =>
      await db.dealer.upsert({
        where: { id: 'test-upsert-1' },
        create: { id: 'test-upsert-1', organizationId: ORG_B, businessName: 'U', source: 'MANUAL' } as never,
        update: { businessName: 'U2' },
      }),
    );
    assert.equal(created.organizationId, ORG_A);
    assert.equal(created.businessName, 'U');

    // Update branch — the row now exists, so this second call takes it. A foreign
    // organizationId in `update` must not move the row out of the context org either.
    const updated = await runWithOrg(ORG_A, async () =>
      await db.dealer.upsert({
        where: { id: 'test-upsert-1' },
        create: { id: 'test-upsert-1', organizationId: ORG_A, businessName: 'U', source: 'MANUAL' },
        update: { businessName: 'U2', organizationId: ORG_B } as never,
      }),
    );
    assert.equal(updated.businessName, 'U2');
    assert.equal(updated.organizationId, ORG_A);
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: 'test-upsert-1' } })).organizationId,
      ORG_A,
    );

    // And an upsert aimed at another org's row is refused outright, both branches.
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.dealer.upsert({
            where: { id: DEALER_B },
            create: { id: DEALER_B, organizationId: ORG_B, businessName: 'X', source: 'MANUAL' },
            update: { businessName: 'HACKED' },
          }),
        ),
    );
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_B } })).businessName,
      'B Traders',
    );

    await raw.dealer.delete({ where: { id: 'test-upsert-1' } });
  });
});

// §1.3. $allOperations only ever sees the TOP-LEVEL args, so everything nested inside
// data/where used to run completely unscoped: a nested connect could steal another
// org's row outright, and a nested create could plant one inside another org. Both are
// closed twice over — composite (organizationId, id) foreign keys in the database, and
// the recursive check in scope() — so these must fail even if one layer is removed.
describe('nested writes cannot cross an org boundary', () => {
  test('FINDING 1: nested connect cannot steal another org user', async () => {
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.organization.update({
            where: { id: ORG_A },
            data: { users: { connect: { id: USER_B } } },
          }),
        ),
      /tenancy/i,
    );
    const victim = await raw.user.findUniqueOrThrow({ where: { id: USER_B } });
    assert.equal(victim.organizationId, ORG_B);
  });

  test('FINDING 1: nested connect cannot steal another org dealer', async () => {
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.organization.update({
            where: { id: ORG_A },
            data: { dealers: { connect: { id: DEALER_B } } },
          }),
        ),
      /tenancy/i,
    );
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_B } })).organizationId,
      ORG_B,
    );
    // Org B still sees its own dealer through its own scoped client.
    const bRows = await runWithOrg(ORG_B, async () => await db.dealer.findMany());
    assert.ok(bRows.some((d) => d.id === DEALER_B));
  });

  test('FINDING 1: nested set/disconnect cannot move another org row', async () => {
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.organization.update({
            where: { id: ORG_A },
            data: { users: { set: [{ id: USER_B }] } },
          }),
        ),
      /tenancy/i,
    );
    assert.equal(
      (await raw.user.findUniqueOrThrow({ where: { id: USER_B } })).organizationId,
      ORG_B,
    );
  });

  test('FINDING 2: a dealer cannot be assigned a salesman from another org', async () => {
    await assert.rejects(() =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.update({ where: { id: DEALER_A }, data: { assignedSalesmanId: USER_B } }),
      ),
    );
    await assert.rejects(() =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.update({
          where: { id: DEALER_A },
          data: { assignedSalesman: { connect: { id: USER_B } } },
        }),
      ),
    );
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_A } })).assignedSalesmanId,
      null,
    );
  });

  test('FINDING 2: a cross-org salesman is refused even when the composite names it', async () => {
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.dealer.update({
            where: { id: DEALER_A },
            data: {
              assignedSalesman: {
                connect: { organizationId_id: { organizationId: ORG_B, id: USER_B } },
              },
            },
          }),
        ),
      /tenancy/i,
    );
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_A } })).assignedSalesmanId,
      null,
    );
  });

  // REGRESSION 2 — the org scalar was injected into `data` unconditionally, which
  // forces Prisma's *unchecked* input variant, and that variant has no forward
  // relation fields at all. So every legitimate in-org write through the relation API
  // (connect / disconnect / set) died on a Prisma validation error. Both forms have to
  // work: services reassign a salesman either way.
  test('an in-org salesman assigns through the relation API, not only the scalar', async () => {
    const assign = (data: object) =>
      runWithOrg(ORG_A, async () => await db.dealer.update({ where: { id: DEALER_A }, data }));
    const assignedNow = async () =>
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_A } })).assignedSalesmanId;

    await assign({
      assignedSalesman: { connect: { organizationId_id: { organizationId: ORG_A, id: USER_A } } },
    });
    assert.equal(await assignedNow(), USER_A);

    // Unassigning through the relation is the one form that stays unavailable, and
    // not for a tenancy reason: `disconnect` nulls every field of the foreign key, and
    // this one includes organizationId, which is NOT NULL. Same root cause as the
    // salesman-offboarding note in §19. The scalar is how a rep is unassigned.
    await assert.rejects(() => assign({ assignedSalesman: { disconnect: true } }), /organizationId/i);
    assert.equal(await assignedNow(), USER_A);

    // The scalar form keeps working — this is an addition, not a swap.
    await assign({ assignedSalesmanId: null });
    assert.equal(await assignedNow(), null);
    await assign({ assignedSalesmanId: USER_A });
    assert.equal(await assignedNow(), USER_A);
    await assign({ assignedSalesmanId: null });
    assert.equal(await assignedNow(), null);

    // Still in org A, whichever form was used.
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: DEALER_A } })).organizationId,
      ORG_A,
    );
  });

  test('a create using the relation API lands in the context org', async () => {
    const created = await runWithOrg(ORG_A, async () =>
      await db.dealer.create({
        data: {
          businessName: 'rel-create',
          source: 'MANUAL',
          assignedSalesman: {
            connect: { organizationId_id: { organizationId: ORG_A, id: USER_A } },
          },
        } as never,
      }),
    );
    assert.equal(created.organizationId, ORG_A);
    assert.equal(created.assignedSalesmanId, USER_A);
    await raw.dealer.delete({ where: { id: created.id } });
  });

  test('FINDING 2: relation traversal yields no other-org user, and no oracle', async () => {
    const found = await runWithOrg(ORG_A, async () =>
      await db.dealer.findFirst({
        where: { id: DEALER_A },
        select: { assignedSalesman: { select: { email: true, passwordHash: true } } },
      }),
    );
    assert.equal(found?.assignedSalesman, null);

    // Blind oracle: filtering dealers through the relation must not probe org B's users.
    const probed = await runWithOrg(ORG_A, async () =>
      await db.dealer.findMany({ where: { assignedSalesman: { name: { contains: 'zzzx' } } } }),
    );
    assert.deepEqual(probed, []);
  });

  test('FINDING 2: an in-org salesman still assigns and traverses', async () => {
    await runWithOrg(ORG_A, async () =>
      await db.dealer.update({ where: { id: DEALER_A }, data: { assignedSalesmanId: USER_A } }),
    );
    const found = await runWithOrg(ORG_A, async () =>
      await db.dealer.findFirst({
        where: { id: DEALER_A },
        select: { assignedSalesman: { select: { id: true } } },
      }),
    );
    assert.equal(found?.assignedSalesman?.id, USER_A);
    await runWithOrg(ORG_A, async () =>
      await db.dealer.update({ where: { id: DEALER_A }, data: { assignedSalesmanId: null } }),
    );
  });

  test('FINDING 5: nested create cannot plant a row in another org', async () => {
    await assert.rejects(
      () =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.create({
          data: {
            businessName: 'poison',
            source: 'MANUAL',
            phones: { create: [{ organizationId: ORG_B, raw: 'PLANTED-BY-ORG-A' }] },
          } as never,
        }),
      ),
      /tenancy/i,
    );
    assert.equal(await raw.dealerPhone.count({ where: { raw: 'PLANTED-BY-ORG-A' } }), 0);
    const bPhones = await runWithOrg(ORG_B, async () => await db.dealerPhone.findMany());
    assert.deepEqual(bPhones, []);
    await raw.dealer.deleteMany({ where: { businessName: 'poison' } });
  });

  test('FINDING 5: nested connectOrCreate is checked too', async () => {
    await assert.rejects(
      () =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.create({
          data: {
            businessName: 'poison-coc',
            source: 'MANUAL',
            phones: {
              connectOrCreate: {
                where: { id: 'test-phone-coc' },
                create: { id: 'test-phone-coc', organizationId: ORG_B, raw: 'PLANTED-COC' },
              },
            },
          } as never,
        }),
      ),
      /tenancy/i,
    );
    assert.equal(await raw.dealerPhone.count({ where: { raw: 'PLANTED-COC' } }), 0);
    await raw.dealer.deleteMany({ where: { businessName: 'poison-coc' } });
  });

  // The composite key has a second effect worth pinning: organizationId is now part of
  // the parent relation, so a nested create cannot even NAME an org — it inherits the
  // parent's. The §5.1 dedup key and §7 send target can no longer be planted at all.
  test('a nested create in the context org still works, inheriting the org', async () => {
    const created = await runWithOrg(ORG_A, async () =>
      await db.dealer.create({
        data: {
          organizationId: ORG_A,
          businessName: 'legit-nested',
          source: 'MANUAL',
          phones: { create: [{ raw: '+91 99999 00000' }] },
        },
        include: { phones: true },
      }),
    );
    assert.equal(created.organizationId, ORG_A);
    assert.equal(created.phones.length, 1);
    assert.equal(created.phones[0].organizationId, ORG_A);
    await raw.dealer.delete({ where: { id: created.id } });
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
  test('a platform context writes a platform-wide row, and it is not rewritten', async () => {
    const written = await runAsPlatformAdmin(async () =>
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
    // Not rewritten to an org — that is the whole point.
    assert.equal(written.organizationId, null);

    const read = await runAsPlatformAdmin(async () =>
      await db.auditEvent.findMany({ where: { organizationId: null, entityId: 'tenancy-metrics' } }),
    );
    assert.deepEqual(read.map((e) => e.id), [written.id]);
  });

  test('an org context writes only its own org rows', async () => {
    const own = await runWithOrg(ORG_A, async () =>
      await db.auditEvent.create({
        data: {
          organizationId: ORG_A,
          actorType: 'USER',
          actorId: USER_A,
          entityType: 'Dealer',
          entityId: DEALER_A,
          action: 'PIPELINE_STAGE_CHANGED',
        },
      }),
    );
    assert.equal(own.organizationId, ORG_A);
  });

  // FINDING 4 — an immutable, undeletable row forged against another tenant is the
  // worst kind of write this table can take (§9, §9A.3).
  test('FINDING 4: a direct create/createMany/upsert cannot name another org', async () => {
    const forged = {
      organizationId: ORG_B,
      actorType: 'USER' as const,
      actorId: 'test-user-b-owner',
      entityType: 'MessageDraft',
      entityId: 'forged-draft',
      action: 'DRAFT_APPROVED',
    };
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.create({ data: forged })),
      /tenancy/i,
    );
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.createMany({ data: [forged] })),
      /tenancy/i,
    );
    // A null (platform-wide) row from a tenant context is a forgery too.
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.auditEvent.create({ data: { ...forged, organizationId: null } }),
        ),
      /tenancy/i,
    );
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.auditEvent.upsert({
            where: { id: 'forged-upsert' },
            create: { ...forged, id: 'forged-upsert' },
            update: {},
          }),
        ),
      /tenancy/i,
    );
    assert.equal(await raw.auditEvent.count({ where: { entityId: 'forged-draft' } }), 0);
  });

  // HOLE 1 — the org check above only ever ran on TOP-LEVEL AuditEvent operations.
  // A nested write through the `auditEvents` relation never reached it (orgFieldOf
  // returns null for AuditEvent, so walkNested checked nothing), and the app database
  // role may INSERT, so nothing else stopped it. That let any tenant user write the
  // trail directly, with an attacker-chosen actorType/actorId/action — forging the
  // §9 evidence of who approved a send. Rows are immutable, so it is permanent.
  // AuditEvent has exactly one legitimate writer: AuditService.record(), top level.
  test('HOLE 1: no nested write reaches AuditEvent, at any depth or shape', async () => {
    const forged = {
      actorType: 'ADMIN' as const,
      actorId: 'attacker',
      entityType: 'Organization',
      entityId: ORG_B,
      action: 'VIEWED_ORG_DATA',
      metadata: { forged: true },
    };
    const refused = (fn: () => Promise<unknown>) => assert.rejects(fn, /tenancy/i);

    // create — the verified exploit.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.organization.update({
          where: { id: ORG_A },
          data: { auditEvents: { create: forged } } as never,
        }),
      ),
    );
    // createMany.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.organization.update({
          where: { id: ORG_A },
          data: { auditEvents: { createMany: { data: [forged] } } } as never,
        }),
      ),
    );
    // connectOrCreate.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.organization.update({
          where: { id: ORG_A },
          data: {
            auditEvents: {
              connectOrCreate: { where: { id: 'forged-coc' }, create: { id: 'forged-coc', ...forged } },
            },
          } as never,
        }),
      ),
    );
    // upsert's update branch.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.organization.upsert({
          where: { id: ORG_A },
          create: { id: ORG_A, name: 'A', slug: ORG_A },
          update: { auditEvents: { create: forged } } as never,
        }),
      ),
    );
    // nested update/delete of an existing row — the table is append-only, but the
    // guard must refuse before the trigger has to.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.organization.update({
          where: { id: ORG_A },
          data: { auditEvents: { deleteMany: {} } } as never,
        }),
      ),
    );
    // One level deeper, through another model's relation to Organization.
    await refused(() =>
      runWithOrg(ORG_A, async () =>
        await db.dealer.update({
          where: { id: DEALER_A },
          data: { organization: { update: { auditEvents: { create: forged } } } } as never,
        }),
      ),
    );
    // Nothing landed, by any route.
    assert.equal(await raw.auditEvent.count({ where: { actorId: 'attacker' } }), 0);

    // Reading through the relation is untouched — it is bounded by the org scope.
    const own = await runWithOrg(ORG_A, async () =>
      await db.organization.findMany({ where: { auditEvents: { some: { actorType: 'USER' } } } }),
    );
    assert.deepEqual(own.map((o) => o.id), [ORG_A]);
  });

  test('FINDING 3: an org context cannot read another org audit trail', async () => {
    await raw.auditEvent.create({
      data: {
        organizationId: ORG_B,
        actorType: 'USER',
        actorId: 'test-user-b-owner',
        entityType: 'Dealer',
        entityId: 'secret-b-entity',
        action: 'PIPELINE_STAGE_CHANGED',
      },
    });
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.findMany({ where: { organizationId: ORG_B } })),
      /refusing/i,
    );
    await assert.rejects(
      () =>
        runWithOrg(ORG_A, async () =>
          await db.auditEvent.findMany({
            where: { organizationId: ORG_B },
            include: { organization: true },
          }),
        ),
      /refusing/i,
    );
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.count({ where: { organizationId: ORG_B } })),
      /refusing/i,
    );
    // Platform-wide rows are not a tenant's to read either.
    await assert.rejects(
      () => runWithOrg(ORG_A, async () => await db.auditEvent.findMany({ where: { organizationId: null } })),
      /refusing/i,
    );
    // Its own org still reads normally.
    const mine = await runWithOrg(ORG_A, async () =>
      await db.auditEvent.findMany({ where: { organizationId: ORG_A } }),
    );
    assert.ok(mine.every((e) => e.organizationId === ORG_A));
  });

  test('FINDING 3: no context at all reads nothing', async () => {
    await assert.rejects(() => db.auditEvent.findMany({ where: { organizationId: ORG_B } }), /tenancy/i);
    await assert.rejects(
      () => db.auditEvent.create({ data: {
        organizationId: ORG_B,
        actorType: 'USER',
        actorId: 'nobody',
        entityType: 'Dealer',
        entityId: 'no-context',
        action: 'PIPELINE_STAGE_CHANGED',
      } }),
      /tenancy/i,
    );
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
