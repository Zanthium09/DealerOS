import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

// §5.5 — shared infrastructure. Exported so M5/M6/M7/M8 read through SyncService
// (freshness, ageing, scorecard) instead of each re-deriving them.
@Module({
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
