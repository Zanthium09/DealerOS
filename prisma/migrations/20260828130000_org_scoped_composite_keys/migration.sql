-- §1.3 pushed into the database: a cross-org `connect` or nested `create` is now a
-- foreign-key violation, not something the application layer has to remember.
-- (organizationId, id) is unique on User and Dealer so every cross-row relation can
-- carry the org in the key itself. ON UPDATE RESTRICT so a parent row cannot be
-- dragged into another org while children reference it.

-- DropForeignKey
ALTER TABLE "ConsentLog" DROP CONSTRAINT "ConsentLog_dealerId_fkey";

-- DropForeignKey
ALTER TABLE "Dealer" DROP CONSTRAINT "Dealer_assignedSalesmanId_fkey";

-- DropForeignKey
ALTER TABLE "DealerEmail" DROP CONSTRAINT "DealerEmail_dealerId_fkey";

-- DropForeignKey
ALTER TABLE "DealerPhone" DROP CONSTRAINT "DealerPhone_dealerId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Dealer_organizationId_id_key" ON "Dealer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_id_key" ON "User"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_organizationId_assignedSalesmanId_fkey" FOREIGN KEY ("organizationId", "assignedSalesmanId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPhone" ADD CONSTRAINT "DealerPhone_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerEmail" ADD CONSTRAINT "DealerEmail_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_organizationId_dealerId_fkey" FOREIGN KEY ("organizationId", "dealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

