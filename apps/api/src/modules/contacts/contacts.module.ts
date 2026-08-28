import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { ContactsController } from './contacts.controller';
import { DedupService } from './dedup.service';
import { ImportService } from './import.service';
import { MergeService } from './merge.service';

// DedupService is exported because §5.0 says M0 calls M1's dedup service rather
// than growing a second implementation of it.
@Module({
  imports: [AuditModule],
  controllers: [ContactsController],
  providers: [DedupService, ImportService, MergeService],
  exports: [DedupService, ImportService, MergeService],
})
export class ContactsModule {}
