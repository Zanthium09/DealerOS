import { PipelineStage, PrismaClient } from '@prisma/client';
import { AuditAction, AuditService } from '../../core/audit';

/** §4 — every pipeline transition writes an AuditEvent. One place, so no transition
 *  anywhere in this module can skip it. */
export async function transitionPipelineStage(
  prisma: PrismaClient,
  audit: AuditService,
  args: { organizationId: string; dealerId: string; from: PipelineStage; to: PipelineStage; reason: string },
): Promise<boolean> {
  // Conditional update: only moves if the dealer is still in the expected `from`
  // stage, so a race (e.g. two webhooks) cannot double-transition or clobber a
  // stage some other module already advanced past.
  const { count } = await prisma.dealer.updateMany({
    where: { id: args.dealerId, pipelineStage: args.from },
    data: { pipelineStage: args.to },
  });
  if (count === 0) return false;

  await audit.record({
    actorType: 'SYSTEM',
    actorId: null,
    organizationId: args.organizationId,
    entityType: 'Dealer',
    entityId: args.dealerId,
    action: AuditAction.PIPELINE_STAGE_CHANGED,
    metadata: { from: args.from, to: args.to, reason: args.reason },
  });
  return true;
}
