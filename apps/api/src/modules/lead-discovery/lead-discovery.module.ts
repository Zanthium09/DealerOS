import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { KillSwitchModule } from '../../core/killswitch';
import { AiModule } from '../../providers/ai';
import { ExtractionProvider, PlacesProvider, RegistryProvider } from '../../providers/discovery';
import { ContactsModule } from '../contacts';
import { DiscoveryService } from './discovery.service';
import { LeadDiscoveryController } from './lead-discovery.controller';

// M0 (§5.0). Imports ContactsModule for its exported DedupService — M0 calls M1's dedup
// rather than growing a second implementation (design doc §5).
@Module({
  imports: [ContactsModule, AuditModule, KillSwitchModule, AiModule],
  controllers: [LeadDiscoveryController],
  providers: [DiscoveryService, ExtractionProvider, PlacesProvider, RegistryProvider],
  exports: [DiscoveryService],
})
export class LeadDiscoveryModule {}
