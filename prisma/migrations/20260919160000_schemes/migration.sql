-- CreateEnum
CREATE TYPE "SchemeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "Scheme" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "terms" TEXT NOT NULL,
    "applicableProductIds" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "targetSegmentRule" JSONB NOT NULL DEFAULT '{}',
    "status" "SchemeStatus" NOT NULL DEFAULT 'DRAFT',
    "activatedAt" TIMESTAMP(3),
    "campaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeRecipient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "draftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemeRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scheme_organizationId_status_idx" ON "Scheme"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Scheme_organizationId_id_key" ON "Scheme"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SchemeRecipient_organizationId_dealerId_idx" ON "SchemeRecipient"("organizationId", "dealerId");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeRecipient_schemeId_dealerId_key" ON "SchemeRecipient"("schemeId", "dealerId");

-- CreateIndex
CREATE INDEX "Order_schemeId_idx" ON "Order"("schemeId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scheme" ADD CONSTRAINT "Scheme_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeRecipient" ADD CONSTRAINT "SchemeRecipient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeRecipient" ADD CONSTRAINT "SchemeRecipient_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeRecipient" ADD CONSTRAINT "SchemeRecipient_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

