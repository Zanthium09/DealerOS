/*
  Warnings:

  - You are about to drop the column `emails` on the `Dealer` table. All the data in the column will be lost.
  - You are about to drop the column `phones` on the `Dealer` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('UNVERIFIED', 'VALID', 'INVALID', 'RISKY');

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_organizationId_fkey";

-- AlterTable
ALTER TABLE "AuditEvent" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Dealer" DROP COLUMN "emails",
DROP COLUMN "phones";

-- CreateTable
CREATE TABLE "DealerPhone" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "e164" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isWhatsapp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DealerPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerEmail" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "verificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DealerEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealerPhone_organizationId_idx" ON "DealerPhone"("organizationId");

-- CreateIndex
CREATE INDEX "DealerPhone_organizationId_e164_idx" ON "DealerPhone"("organizationId", "e164");

-- CreateIndex
CREATE INDEX "DealerPhone_dealerId_idx" ON "DealerPhone"("dealerId");

-- CreateIndex
CREATE INDEX "DealerEmail_organizationId_idx" ON "DealerEmail"("organizationId");

-- CreateIndex
CREATE INDEX "DealerEmail_organizationId_address_idx" ON "DealerEmail"("organizationId", "address");

-- CreateIndex
CREATE INDEX "DealerEmail_dealerId_idx" ON "DealerEmail"("dealerId");

-- AddForeignKey
ALTER TABLE "DealerPhone" ADD CONSTRAINT "DealerPhone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerPhone" ADD CONSTRAINT "DealerPhone_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerEmail" ADD CONSTRAINT "DealerEmail_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerEmail" ADD CONSTRAINT "DealerEmail_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
