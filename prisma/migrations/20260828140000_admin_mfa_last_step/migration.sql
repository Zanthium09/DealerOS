-- Finding 11: persist the TOTP replay guard.
--
-- It lived in a module-level Map, so a deploy or a crash inside a code's 90-second
-- acceptance window reopened the replay an attacker with a real-time phishing proxy
-- needs, and a second API replica never saw the first one's accepted steps at all.
-- On the row, the guard survives a restart and is shared across replicas, and the
-- claim can be made atomic (conditional UPDATE) instead of read-then-write.
ALTER TABLE "AdminUser" ADD COLUMN "mfaLastStep" INTEGER;
