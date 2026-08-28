// Pins the per-node scalar organizationId check in walkNested (tenancy.ts).
//
// Every relation in the schema is composite (organizationId, id), so Prisma's own
// checked-input validation already rejects a nested payload that names an
// organizationId — which made this guard defence-in-depth with an unreachable failure
// mode, and completely uncovered: deleting the refuseNested call left all 70 tenancy
// and audit tests green. DuplicateCandidate.importBatchId shipped as a plain id
// foreign key, so that schema drift is not hypothetical. A relation filter is the one
// input shape Prisma does accept an organizationId in, so it is the cheapest way to
// hold the guard down until the next composite key goes missing.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';

const raw = new PrismaClient();
const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;

const ORG_A = 'nested-scalar-org-a';
const ORG_B = 'nested-scalar-org-b';

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Nested A', slug: ORG_A },
      { id: ORG_B, name: 'Nested B', slug: ORG_B },
    ],
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('nested scalar organizationId (§1.3)', () => {
  test("a nested node naming another org's id is refused, not silently scoped away", async () => {
    await runWithOrg(ORG_A, async () => {
      await assert.rejects(
        () => db.dealer.findMany({ where: { phones: { some: { organizationId: ORG_B } } } }),
        /nested .*organizationId/i,
      );
    });
  });

  test('the same node naming the context org is fine', async () => {
    await runWithOrg(ORG_A, async () => {
      assert.deepEqual(
        await db.dealer.findMany({ where: { phones: { some: { organizationId: ORG_A } } } }),
        [],
      );
    });
  });
});
