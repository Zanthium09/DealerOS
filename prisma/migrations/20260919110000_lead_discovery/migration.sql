-- CreateEnum
CREATE TYPE "DiscoveryMethod" AS ENUM ('PLACES_API', 'REGISTRY', 'URL_EXTRACT', 'FILE_EXTRACT');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "RefusalReason" AS ENUM ('ROBOTS_DISALLOWED', 'BLOCKLISTED_DOMAIN', 'LOGIN_WALL', 'BLOCKED_BY_SITE', 'NON_PUBLIC_ADDRESS');

-- CreateEnum
CREATE TYPE "LeadDedupeStatus" AS ENUM ('UNIQUE', 'POSSIBLE_DUPLICATE', 'CONFIRMED_DUPLICATE');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "OutreachSettings" ADD COLUMN     "discoveryPaused" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "method" "DiscoveryMethod" NOT NULL,
    "query" JSONB NOT NULL DEFAULT '{}',
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
    "refusalReason" "RefusalReason",
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "costPaise" INTEGER NOT NULL DEFAULT 0,
    "triggeredByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "rawExcerpt" TEXT,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadCandidate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "discoveryRunId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactPersonName" TEXT,
    "rawPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rawEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "category" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "dedupeStatus" "LeadDedupeStatus" NOT NULL DEFAULT 'UNIQUE',
    "matchedDealerId" TEXT,
    "matchScore" DOUBLE PRECISION,
    "status" "LeadStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "promotedDealerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryRun_organizationId_startedAt_idx" ON "DiscoveryRun"("organizationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryRun_organizationId_id_key" ON "DiscoveryRun"("organizationId", "id");

-- CreateIndex
CREATE INDEX "LeadCandidate_organizationId_status_idx" ON "LeadCandidate"("organizationId", "status");

-- CreateIndex
CREATE INDEX "LeadCandidate_organizationId_discoveryRunId_idx" ON "LeadCandidate"("organizationId", "discoveryRunId");

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCandidate" ADD CONSTRAINT "LeadCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCandidate" ADD CONSTRAINT "LeadCandidate_organizationId_discoveryRunId_fkey" FOREIGN KEY ("organizationId", "discoveryRunId") REFERENCES "DiscoveryRun"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

