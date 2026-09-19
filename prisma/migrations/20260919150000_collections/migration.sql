-- CreateEnum
CREATE TYPE "EscalationLevel" AS ENUM ('NONE', 'GENTLE', 'FIRM', 'HUMAN');

-- CreateTable
CREATE TABLE "CollectionsSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "gentleAfterDays" INTEGER NOT NULL DEFAULT 3,
    "firmAfterDays" INTEGER NOT NULL DEFAULT 30,
    "humanAfterDays" INTEGER NOT NULL DEFAULT 60,
    "reminderIntervalDays" INTEGER NOT NULL DEFAULT 7,
    "freshnessWindowHours" INTEGER NOT NULL DEFAULT 72,
    "lastRunAt" TIMESTAMP(3),
    "lastRunSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionCase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "level" "EscalationLevel" NOT NULL DEFAULT 'NONE',
    "oldestDaysOverdue" INTEGER NOT NULL DEFAULT 0,
    "outstanding" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overdueInvoices" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "lastReminderLevel" "EscalationLevel",
    "needsCall" BOOLEAN NOT NULL DEFAULT false,
    "callReason" TEXT,
    "handledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionsSettings_organizationId_key" ON "CollectionsSettings"("organizationId");

-- CreateIndex
CREATE INDEX "CollectionCase_organizationId_level_idx" ON "CollectionCase"("organizationId", "level");

-- CreateIndex
CREATE INDEX "CollectionCase_organizationId_needsCall_idx" ON "CollectionCase"("organizationId", "needsCall");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCase_organizationId_dealerId_key" ON "CollectionCase"("organizationId", "dealerId");

-- AddForeignKey
ALTER TABLE "CollectionsSettings" ADD CONSTRAINT "CollectionsSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCase" ADD CONSTRAINT "CollectionCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCase" ADD CONSTRAINT "CollectionCase_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

