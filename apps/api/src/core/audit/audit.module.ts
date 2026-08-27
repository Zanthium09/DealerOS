import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Audit writes fail loudly (§1.6, §9A.3).
 *
 * `AuditService.record()` rejects on failure and does not catch. There is no
 * "best effort" variant, because §9A.3 puts an unaudited admin view at the same
 * standing as a missing ConsentLog row — a compliance failure, not a warning.
 * A caller that genuinely wants best-effort has to write the `catch` itself,
 * in the open, where a reviewer can see it.
 *
 * For anything that changes data, pass the caller's transaction client to
 * `record(event, tx)` so the change and its audit row commit together.
 */
// The client is the shared, tenancy-scoped one (@Global PRISMA from TenancyModule).
// AuditEvent is classified as its own thing there — no org injection, because
// record() below takes organizationId explicitly and a platform-wide row's null must
// survive (§9A.3, tenancy.ts AUDIT_MODELS).
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
