-- Append-only enforcement for AuditEvent (§4 "immutable") and ConsentLog
-- (§1.6, §4 "append-only … the DPDP audit trail — never destroy it").
--
-- In the database, not in a comment: this holds for Prisma, psql, a future admin
-- tool, and any agent who forgets. RAISE aborts the whole statement and its
-- transaction, so a mutation attempt cannot half-succeed.
--
-- Why a trigger and not REVOKE UPDATE, DELETE: the app connects as the schema
-- owner (Prisma migrate needs DDL), and grants do not apply to the table owner —
-- a revoke would enforce nothing here without splitting into two roles. The
-- trigger binds to the table, not to whoever is connected.

CREATE OR REPLACE FUNCTION append_only_table() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and immutable (CLAUDE.md 1.6, 4): % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_no_mutate ON "AuditEvent";
CREATE TRIGGER audit_event_no_mutate
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION append_only_table();

-- Row triggers do not see TRUNCATE, which would otherwise empty the table.
DROP TRIGGER IF EXISTS audit_event_no_truncate ON "AuditEvent";
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_table();

DROP TRIGGER IF EXISTS consent_log_no_mutate ON "ConsentLog";
CREATE TRIGGER consent_log_no_mutate
  BEFORE UPDATE OR DELETE ON "ConsentLog"
  FOR EACH ROW EXECUTE FUNCTION append_only_table();

DROP TRIGGER IF EXISTS consent_log_no_truncate ON "ConsentLog";
CREATE TRIGGER consent_log_no_truncate
  BEFORE TRUNCATE ON "ConsentLog"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_table();
