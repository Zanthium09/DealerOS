-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('CSV_IMPORT', 'ORDERING_BOT', 'MANUAL', 'ACCOUNTING_SYNC');

-- CreateEnum
CREATE TYPE "AgeingBucket" AS ENUM ('CURRENT', 'D30', 'D60', 'D90_PLUS');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('ORDERS', 'PAYMENTS', 'PRODUCTS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "externalRef" TEXT,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "totalValue" DECIMAL(14,2) NOT NULL,
    "source" "OrderSource" NOT NULL,
    "schemeId" TEXT,
    "syncBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidDate" TIMESTAMP(3),
    "ageingBucket" "AgeingBucket" NOT NULL DEFAULT 'CURRENT',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "syncBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_organizationId_idx" ON "Product"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON "Product"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "Order_organizationId_dealerId_orderDate_idx" ON "Order"("organizationId", "dealerId", "orderDate");

-- CreateIndex
CREATE INDEX "Order_organizationId_orderDate_idx" ON "Order"("organizationId", "orderDate");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_id_key" ON "Order"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_externalRef_key" ON "Order"("organizationId", "externalRef");

-- CreateIndex
CREATE INDEX "OrderLineItem_organizationId_idx" ON "OrderLineItem"("organizationId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_organizationId_dealerId_idx" ON "PaymentLedgerEntry"("organizationId", "dealerId");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_organizationId_ageingBucket_idx" ON "PaymentLedgerEntry"("organizationId", "ageingBucket");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLedgerEntry_organizationId_invoiceRef_key" ON "PaymentLedgerEntry"("organizationId", "invoiceRef");

-- CreateIndex
CREATE INDEX "SyncBatch_organizationId_kind_finishedAt_idx" ON "SyncBatch"("organizationId", "kind", "finishedAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SyncBatch" ADD CONSTRAINT "SyncBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

