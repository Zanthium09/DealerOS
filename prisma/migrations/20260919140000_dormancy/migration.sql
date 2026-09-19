-- CreateTable
CREATE TABLE "DormancySettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "thresholdDays" INTEGER NOT NULL DEFAULT 30,
    "autoSendBelowAov" DECIMAL(14,2),
    "attributionWindowDays" INTEGER NOT NULL DEFAULT 30,
    "lastScanAt" TIMESTAMP(3),
    "lastScanSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DormancySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DormancySettings_organizationId_key" ON "DormancySettings"("organizationId");

-- AddForeignKey
ALTER TABLE "DormancySettings" ADD CONSTRAINT "DormancySettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

