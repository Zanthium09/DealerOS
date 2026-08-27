// `prisma migrate` runs as the schema OWNER, the API runs as the app role
// (finding 6, CLAUDE.md 19). schema.prisma reads DATABASE_URL, which is now the
// app role, so this hands prisma MIGRATE_DATABASE_URL under that name instead.
//
//   pnpm prisma:migrate            -> migrate dev
//   pnpm prisma:deploy             -> migrate deploy
//   node --env-file=.env apps/api/scripts/migrate.mjs migrate status
import { spawnSync } from 'node:child_process';

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL is not set — see .env.example. It is the OWNER URL.');
  process.exit(1);
}

const { status } = spawnSync('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(status ?? 1);
