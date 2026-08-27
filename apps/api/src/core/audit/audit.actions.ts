/**
 * The actions CLAUDE.md actually names. Nothing invented for modules that do not
 * exist yet — add a constant when the module that writes it is being built.
 *
 *   §4     every pipeline transition writes an AuditEvent
 *   §9     every send — auto or approved — records who approved it / which rule fired
 *   §9A.3  admin views, admin writes, org suspension
 *   §5.1 / §10.1  dedup merges are logged as reversible operations
 */
export const AuditAction = {
  /** §4. metadata: { from, to, reason? } */
  PIPELINE_STAGE_CHANGED: 'PIPELINE_STAGE_CHANGED',

  /** §9A.3. actorType ADMIN, organizationId = the org whose data was viewed. */
  VIEWED_ORG_DATA: 'VIEWED_ORG_DATA',
  /** §9A.3. Elevated write on a tenant's data — never bundled into a read-only view. */
  WROTE_ORG_DATA: 'WROTE_ORG_DATA',
  /** §9A.3. */
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',

  /** §9. metadata: { approvedByUserId } */
  DRAFT_APPROVED: 'DRAFT_APPROVED',
  /** §9. metadata: { autoSendRuleId } */
  DRAFT_AUTO_SENT: 'DRAFT_AUTO_SENT',

  /** §5.1 / §10.1. entityId = surviving dealer. metadata must carry enough to reverse it. */
  DEALER_MERGED: 'DEALER_MERGED',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
