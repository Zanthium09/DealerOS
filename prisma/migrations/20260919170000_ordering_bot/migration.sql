-- CreateEnum
CREATE TYPE "BotDraftStatus" AS ENUM ('OPEN', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "OrderingBotSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pilotLimit" INTEGER NOT NULL DEFAULT 30,
    "maxLineQuantity" INTEGER NOT NULL DEFAULT 500,
    "draftExpiryMinutes" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderingBotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderingBotPilot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderingBotPilot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotOrderDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "status" "BotDraftStatus" NOT NULL DEFAULT 'OPEN',
    "lines" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotOrderDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderingBotSettings_organizationId_key" ON "OrderingBotSettings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderingBotPilot_organizationId_dealerId_key" ON "OrderingBotPilot"("organizationId", "dealerId");

-- CreateIndex
CREATE INDEX "BotOrderDraft_organizationId_dealerId_status_idx" ON "BotOrderDraft"("organizationId", "dealerId", "status");

-- AddForeignKey
ALTER TABLE "OrderingBotSettings" ADD CONSTRAINT "OrderingBotSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderingBotPilot" ADD CONSTRAINT "OrderingBotPilot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderingBotPilot" ADD CONSTRAINT "OrderingBotPilot_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BotOrderDraft" ADD CONSTRAINT "BotOrderDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotOrderDraft" ADD CONSTRAINT "BotOrderDraft_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

