-- CreateTable
CREATE TABLE "OutreachSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cronExpression" TEXT NOT NULL,
    "maxDealersPerRun" INTEGER,
    "segmentFilter" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "OutreachSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachSchedule_organizationId_idx" ON "OutreachSchedule"("organizationId");

-- AddForeignKey
ALTER TABLE "OutreachSchedule" ADD CONSTRAINT "OutreachSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
