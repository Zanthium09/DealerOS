-- §1.3 — DuplicateCandidate.importBatchId was the last non-composite foreign key:
-- a plain id, so a batch id from another org was a valid reference and
-- `include: { importBatch: true }` returned that org's row through a scoped client.
-- Composite like every other child relation, a cross-org reference is now a
-- foreign-key violation.

-- DropForeignKey
ALTER TABLE "DuplicateCandidate" DROP CONSTRAINT "DuplicateCandidate_importBatchId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_organizationId_id_key" ON "ImportBatch"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_organizationId_importBatchId_fkey" FOREIGN KEY ("organizationId", "importBatchId") REFERENCES "ImportBatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

