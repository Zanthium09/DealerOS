-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('SPOKE_INTERESTED', 'SPOKE_CALL_BACK', 'SPOKE_NOT_INTERESTED', 'ONBOARDED', 'NO_ANSWER', 'WRONG_NUMBER', 'DO_NOT_CALL');

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "calledByUserId" TEXT,
    "phoneE164" TEXT,
    "outcome" "CallOutcome" NOT NULL,
    "notes" TEXT,
    "durationSeconds" INTEGER,
    "calledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followUpAt" TIMESTAMP(3),
    "followUpDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallLog_organizationId_dealerId_calledAt_idx" ON "CallLog"("organizationId", "dealerId", "calledAt");

-- CreateIndex
CREATE INDEX "CallLog_organizationId_followUpAt_idx" ON "CallLog"("organizationId", "followUpAt");

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

