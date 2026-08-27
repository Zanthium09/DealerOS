-- Least-privilege application role (finding 6).
--
-- The previous migration's own comment said a REVOKE "would enforce nothing here
-- without splitting into two roles". This is that split.
--
-- The app connected as the table owner, which is also a superuser in the compose
-- image. From that role the append-only triggers are decoration:
--     ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_event_no_mutate;   -- owner
--     SET session_replication_role = 'replica';                         -- superuser
--     DROP TRIGGER consent_log_no_mutate ON "ConsentLog";               -- owner
-- all succeeded, and rows were then updated and deleted. rolbypassrls was also
-- true, so the Postgres RLS that CLAUDE.md 1.3 offers as the alternative to Prisma
-- middleware would have been equally void under that role.
--
-- After this migration there are two roles:
--   dealeros      — owner/DDL. Runs `prisma migrate` ONLY (MIGRATE_DATABASE_URL).
--   dealeros_app  — what the API, the seed and every runtime connection use
--                   (DATABASE_URL). Not the owner, not a superuser: it cannot
--                   disable, drop or bypass a trigger, and it holds no UPDATE,
--                   DELETE or TRUNCATE on the two append-only tables at all.
--
-- PRODUCTION: create dealeros_app yourself, with a real password, before running
-- migrations. The guarded CREATE below then does nothing and only the grants apply.
-- The dev password here is deliberately as boring as POSTGRES_PASSWORD in
-- docker-compose, and is only ever reachable on localhost:5433.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dealeros_app') THEN
    CREATE ROLE dealeros_app
      LOGIN PASSWORD 'dealeros_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- CONNECT is granted to PUBLIC by default; say it anyway so a hardened cluster
-- that revoked it does not silently lock the API out.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dealeros_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO dealeros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dealeros_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dealeros_app;

-- Tables created by later migrations (run as this owner) get the same grants, so
-- adding a model does not mean remembering to come back here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dealeros_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dealeros_app;

-- Append-only in privileges as well as in triggers (CLAUDE.md 1.6, 4). Two
-- independent layers: the trigger binds to the table, the revoke binds to the role.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent" FROM dealeros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "ConsentLog" FROM dealeros_app;
