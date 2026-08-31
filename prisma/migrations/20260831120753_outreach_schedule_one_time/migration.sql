-- AlterTable
ALTER TABLE "OutreachSchedule" ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ALTER COLUMN "cronExpression" DROP NOT NULL;
