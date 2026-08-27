// Finding 6 — the append-only triggers on AuditEvent and ConsentLog only hold if the
// connection cannot turn them off.
//
// They previously did not. The app connected as the table OWNER, which the compose
// image also makes a SUPERUSER, and from that connection every one of these worked:
//     ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_no_mutate;  -> rows tampered
//     SET session_replication_role = 'replica';                        -> rows deleted
//     DROP TRIGGER consent_log_no_mutate ON "ConsentLog";              -> rows deleted
// rolbypassrls was true as well, so the Postgres RLS that §1.3 offers as the
// alternative to Prisma middleware would have been just as void under that role.
//
// audit.test.ts proves the triggers fire. This file proves the application role
// cannot get at the triggers in the first place — the layer underneath.
//
// The suite's own DATABASE_URL is the owner (test/run.mjs has to CREATE, DROP and
// migrate the throwaway database). These checks connect to that same database as
// dealeros_app instead: the role migration 20260828120000 creates and the role the
// API's DATABASE_URL uses in .env.example.
import '../support';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';

const APP_ROLE = 'dealeros_app';

function appRoleUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = APP_ROLE;
  // The dev password from the migration's guarded CREATE ROLE. Production creates
  // the role itself with a real one; the suite only ever runs against compose.
  url.password = APP_ROLE;
  return url.toString();
}

const app = new PrismaClient({ datasourceUrl: appRoleUrl() });

after(async () => {
  await app.$disconnect();
});

describe('the application database role cannot defeat the append-only triggers (finding 6)', () => {
  test('it is not a superuser and does not bypass RLS', async () => {
    const [row] = await app.$queryRawUnsafe<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >('SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.equal(row.current_user, APP_ROLE);
    assert.equal(row.rolsuper, false);
    // §1.3's RLS alternative is only worth reaching for from a role that cannot
    // ignore it. This is the assertion that keeps that door open.
    assert.equal(row.rolbypassrls, false);
  });

  for (const table of ['AuditEvent', 'ConsentLog']) {
    test(`ALTER TABLE ... DISABLE TRIGGER is rejected on ${table}`, async () => {
      await assert.rejects(
        app.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`),
        /must be owner/i,
      );
    });

    test(`DROP TRIGGER is rejected on ${table}`, async () => {
      const trigger = table === 'AuditEvent' ? 'audit_event_no_mutate' : 'consent_log_no_mutate';
      await assert.rejects(
        app.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "${table}"`),
        /must be owner/i,
      );
    });

    // Belt as well as braces: with the triggers unreachable, the role also simply
    // has no UPDATE/DELETE/TRUNCATE privilege on these two tables. Either layer
    // alone stops the tampering; the point is that neither depends on the other.
    test(`UPDATE, DELETE and TRUNCATE are denied outright on ${table}`, async () => {
      for (const sql of [
        `UPDATE "${table}" SET "id" = 'x'`,
        `DELETE FROM "${table}"`,
        `TRUNCATE "${table}"`,
      ]) {
        await assert.rejects(app.$executeRawUnsafe(sql), /permission denied/i, sql);
      }
    });
  }

  test("session_replication_role = 'replica' is rejected", async () => {
    // The superuser escape hatch that skips every trigger at once, including the
    // statement-level TRUNCATE guards.
    await assert.rejects(
      app.$executeRawUnsafe(`SET session_replication_role = 'replica'`),
      /permission denied to set parameter/i,
    );
  });

  test('the role can still do its job — append an audit row and read it back', async () => {
    // Least privilege that broke the audit write path would be worse than no
    // privilege change at all: §9A.3's audit write must not be able to fail.
    const id = `db-role-${Date.now().toString(36)}`;
    await app.$executeRawUnsafe(
      `INSERT INTO "AuditEvent" ("id","actorType","entityType","entityId","action")
       VALUES ($1, 'SYSTEM', 'Test', $1, 'DB_ROLE_CHECK')`,
      id,
    );
    const rows = await app.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "AuditEvent" WHERE id = $1`,
      id,
    );
    assert.equal(rows.length, 1);
  });
});
