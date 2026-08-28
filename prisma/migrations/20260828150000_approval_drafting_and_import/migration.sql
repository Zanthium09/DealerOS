-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_SENT', 'EDITED_AND_SENT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('MAPPING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MatchReason" AS ENUM ('PHONE_E164', 'EMAIL', 'FUZZY_NAME_CITY');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PENDING', 'MERGED', 'REJECTED');

-- CreateTable
CREATE TABLE "MessageDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "sourceModule" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "templateVariables" JSONB NOT NULL DEFAULT '{}',
    "containsFinancialTerms" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "approvedByUserId" TEXT,
    "autoSendRuleId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "source" "DealerSource" NOT NULL,
    "columnMapping" JSONB NOT NULL DEFAULT '{}',
    "status" "ImportStatus" NOT NULL DEFAULT 'MAPPING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "matchedDealerId" TEXT NOT NULL,
    "incomingPayload" JSONB NOT NULL,
    "matchReason" "MatchReason" NOT NULL,
    "matchScore" DOUBLE PRECISION,
    "status" "CandidateStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerMerge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "survivingDealerId" TEXT NOT NULL,
    "mergedDealerId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerMerge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageDraft_organizationId_status_idx" ON "MessageDraft"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MessageDraft_organizationId_dealerId_idx" ON "MessageDraft"("organizationId", "dealerId");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_createdAt_idx" ON "ImportBatch"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "DuplicateCandidate_organizationId_status_idx" ON "DuplicateCandidate"("organizationId", "status");

-- CreateIndex
CREATE INDEX "DealerMerge_organizationId_createdAt_idx" ON "DealerMerge"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDraft" ADD CONSTRAINT "MessageDraft_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_organizationId_matchedDealerId_fkey" FOREIGN KEY ("organizationId", "matchedDealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerMerge" ADD CONSTRAINT "DealerMerge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
