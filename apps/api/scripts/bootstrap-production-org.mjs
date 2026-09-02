// One-time production bootstrap: the FIRST real Organization + OWNER User.
// seed.mjs is dev-only (refuses NODE_ENV=production, ships dev-placeholder
// defaults) — this is its production counterpart: real values only, no
// fallback defaults, so a missing env var fails loudly instead of quietly
// creating "Dev Owner" in the real database.
//
// Idempotent by org slug (upsert), same as seed.mjs, so re-running this after
// the org already exists just updates the owner's password rather than
// duplicating anything. Intended to run ONCE via a pre-deploy command, then
// be removed from it — see the deploy notes in git history for this file.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set — refusing to bootstrap with a missing value.`);
    process.exit(1);
  }
  return value;
}

const ORG_SLUG = required('BOOTSTRAP_ORG_SLUG');
const ORG_NAME = required('BOOTSTRAP_ORG_NAME');
const OWNER_EMAIL = required('BOOTSTRAP_OWNER_EMAIL');
const OWNER_PASSWORD = required('BOOTSTRAP_OWNER_PASSWORD');
const OWNER_NAME = required('BOOTSTRAP_OWNER_NAME');

const prisma = new PrismaClient();

try {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: { slug: ORG_SLUG, name: ORG_NAME },
  });

  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: OWNER_EMAIL } },
    update: { passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 12) },
    create: {
      organizationId: org.id,
      email: OWNER_EMAIL,
      name: OWNER_NAME,
      role: 'OWNER',
      passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 12),
    },
  });

  console.log(`organization  ${org.slug}  (${org.id})`);
  console.log(`owner user    ${user.email}  -> POST /auth/login`);
} finally {
  await prisma.$disconnect();
}
