// Local dev seed: one Organization, one OWNER User, one PLATFORM_ADMIN AdminUser.
//   pnpm db:seed
//
// Credentials come from the environment; the defaults below are dev-only and
// obviously so. Nothing here is a secret worth committing, and nothing here runs
// against a database whose URL you did not set yourself.
//
// The admin is seeded WITHOUT MFA enrolled on purpose (§9A.2): enrolment is a
// two-step flow with a real authenticator, and a seeded second factor would be a
// shared one. First run: POST /admin/auth/mfa/enrol, then /mfa/confirm.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const env = (name, fallback) => process.env[name] ?? fallback;

const ORG_SLUG = env('SEED_ORG_SLUG', 'dev-distributors');
const ORG_NAME = env('SEED_ORG_NAME', 'Dev Distributors');
const USER_EMAIL = env('SEED_USER_EMAIL', 'owner@dev.local');
const USER_PASSWORD = env('SEED_USER_PASSWORD', 'dev-password-change-me');
const ADMIN_EMAIL = env('SEED_ADMIN_EMAIL', 'admin@dev.local');
const ADMIN_PASSWORD = env('SEED_ADMIN_PASSWORD', 'dev-password-change-me');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed with NODE_ENV=production.');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: { slug: ORG_SLUG, name: ORG_NAME },
  });

  const user = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: USER_EMAIL } },
    update: { passwordHash: bcrypt.hashSync(USER_PASSWORD, 12) },
    create: {
      organizationId: org.id,
      email: USER_EMAIL,
      name: 'Dev Owner',
      role: 'OWNER',
      passwordHash: bcrypt.hashSync(USER_PASSWORD, 12),
    },
  });

  const admin = await prisma.adminUser.upsert({
    where: { email: ADMIN_EMAIL },
    update: { passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 12) },
    create: {
      email: ADMIN_EMAIL,
      role: 'PLATFORM_ADMIN',
      passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 12),
    },
  });

  console.log(`organization  ${org.slug}  (${org.id})`);
  console.log(`tenant user   ${user.email}  -> POST /auth/login`);
  console.log(
    `platform admin ${admin.email}  -> POST /admin/auth/mfa/enrol, then /admin/auth/login`,
  );
} finally {
  await prisma.$disconnect();
}
