// CLAUDE.md §19 — "In production, create dealeros_app yourself with a real
// password before the first deploy." Runs as a pre-deploy step, before
// `pnpm prisma:deploy`, against the OWNER connection (MIGRATE_DATABASE_URL) so the
// migration's own guarded CREATE ROLE (20260828120000_app_role_least_privilege)
// finds the role already present and only applies the GRANTs. Idempotent — safe to
// run on every deploy, not just the first.
import { spawnSync } from 'node:child_process';

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;

if (!ownerUrl) {
  console.error('MIGRATE_DATABASE_URL is not set — cannot create dealeros_app.');
  process.exit(1);
}
if (!password) {
  console.error('APP_DB_PASSWORD is not set — refusing to create dealeros_app without a real password.');
  process.exit(1);
}
if (!/^[A-Za-z0-9]+$/.test(password)) {
  console.error('APP_DB_PASSWORD must be alphanumeric only (this script interpolates it into raw SQL).');
  process.exit(1);
}

const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealeros_app') THEN
    CREATE ROLE dealeros_app
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE dealeros_app PASSWORD '${password}';
  END IF;
END
$$;
`;

const { status } = spawnSync('npx', ['prisma', 'db', 'execute', `--url=${ownerUrl}`, '--stdin'], {
  input: sql,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});
process.exit(status ?? 1);
