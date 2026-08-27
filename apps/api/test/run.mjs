// Test database harness (§13 — the money paths get real tests, against a real
// Postgres, never against the developer's database).
//
// One throwaway database per run: CREATE → `prisma migrate deploy` → run the suite →
// DROP, always. Nothing in the suite deletes anything, because nothing survives the
// run. That also means the immutability triggers (AuditEvent, ConsentLog) are simply
// on, exactly as they are in production, instead of being installed and removed by a
// test that then has to clean up rows it can no longer delete.
//
// Driven by TEST_DATABASE_URL, which must not be DATABASE_URL.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const template = process.env.TEST_DATABASE_URL;
if (!template) {
  console.error('TEST_DATABASE_URL is not set — see .env.example.');
  process.exit(1);
}

const url = new URL(template);
const base = url.pathname.replace(/^\//, '');
if (!/test/i.test(base)) {
  console.error(`TEST_DATABASE_URL database name ("${base}") must contain "test".`);
  process.exit(1);
}
if (process.env.DATABASE_URL === template) {
  console.error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
  process.exit(1);
}

const dbName = `${base}_${Date.now().toString(36)}`;
const testUrl = new URL(url);
testUrl.pathname = `/${dbName}`;

// Connect to the maintenance database to create and drop the throwaway one.
const maintenance = new URL(url);
maintenance.pathname = '/postgres';
const admin = new PrismaClient({ datasourceUrl: maintenance.toString() });

const run = (cmd, args, env) =>
  spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  }).status ?? 1;

let status = 1;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  console.log(`test database: ${dbName}`);

  const childEnv = { DATABASE_URL: testUrl.toString() };
  status = run('npx', ['prisma', 'migrate', 'deploy'], childEnv);
  if (status === 0) {
    status = run('node', ['--test', '"apps/api/dist-test/test/**/*.test.js"'], childEnv);
  }
} finally {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.$disconnect();
}

process.exit(status);
