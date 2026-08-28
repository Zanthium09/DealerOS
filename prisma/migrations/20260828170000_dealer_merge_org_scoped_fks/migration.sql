-- AddForeignKey
ALTER TABLE "DealerMerge" ADD CONSTRAINT "DealerMerge_organizationId_survivingDealerId_fkey" FOREIGN KEY ("organizationId", "survivingDealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerMerge" ADD CONSTRAINT "DealerMerge_organizationId_mergedDealerId_fkey" FOREIGN KEY ("organizationId", "mergedDealerId") REFERENCES "Dealer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
