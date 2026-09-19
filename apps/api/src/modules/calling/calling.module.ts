import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { SyncModule } from '../sync';
import { BriefService } from './brief.service';
import { CallService } from './call.service';
import { CallingController } from './calling.controller';

// M4 (§5.4). Human-initiated only: this module compiles a brief and records an outcome.
// It places no call and has no voice API — §17 Phase 4: "Do not build a dialer", and any
// automated dialling needs DLT/TRAI registration first, which has its own lead time.
@Module({
  imports: [AuditModule, SyncModule],
  controllers: [CallingController],
  providers: [CallService, BriefService],
  exports: [CallService],
})
export class CallingModule {}
