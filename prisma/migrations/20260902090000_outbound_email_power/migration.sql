-- Outbound email: real subjects, real sender identity, retriable failures,
-- per-org throttle settings.

-- MessageDraft: subject/html/cc/bcc + failure bookkeeping so a failed send is
-- distinguishable from one merely awaiting dispatch (previously it was not, which
-- is why nothing could retry).
ALTER TABLE "MessageDraft"
  ADD COLUMN "subject"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN "bodyHtml"      TEXT,
  ADD COLUMN "ccEmails"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bccEmails"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "lastSendError" TEXT,
  ADD COLUMN "sendAttempts"  INTEGER NOT NULL DEFAULT 0;

-- InteractionEvent: record what actually went out and why a FAILED row failed.
ALTER TABLE "InteractionEvent"
  ADD COLUMN "subject"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "toAddress" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "errorText" TEXT;

-- SendingIdentity: From display name / local part / Reply-To were hardcoded.
ALTER TABLE "SendingIdentity"
  ADD COLUMN "fromName"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN "fromLocalPart"  TEXT NOT NULL DEFAULT 'sales',
  ADD COLUMN "replyToAddress" TEXT;

-- OutreachTemplate: subject line, optional HTML, and an opt-out of the AI rewrite.
-- useAi = false renders deterministically and never shows the text to a model,
-- which is what allows literal digits in human-authored copy under §1.4.
ALTER TABLE "OutreachTemplate"
  ADD COLUMN "subject"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "bodyHtml" TEXT,
  ADD COLUMN "useAi"    BOOLEAN NOT NULL DEFAULT true;

-- Per-organization outbound settings (§6, §12.6).
CREATE TABLE "OutreachSettings" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL,
  "throttleEnabled"   BOOLEAN NOT NULL DEFAULT true,
  "warmupEnabled"     BOOLEAN NOT NULL DEFAULT true,
  "dailyLimit"        INTEGER NOT NULL DEFAULT 50,
  "minSendIntervalMs" INTEGER NOT NULL DEFAULT 500,
  "emailPaused"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutreachSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutreachSettings_organizationId_key"
  ON "OutreachSettings"("organizationId");

ALTER TABLE "OutreachSettings"
  ADD CONSTRAINT "OutreachSettings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- §19 — new tables do get the app role's grants automatically via ALTER DEFAULT
-- PRIVILEGES, so nothing to grant here. OutreachSettings is not append-only, so it
-- deliberately keeps UPDATE/DELETE.
