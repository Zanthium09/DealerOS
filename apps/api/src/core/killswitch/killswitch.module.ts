import { Module, OnModuleDestroy } from '@nestjs/common';
import { closeSharedRedis, sharedRedis } from '../redis';
import { KillSwitchService } from './killswitch.service';
import { REDIS } from './killswitch.tokens';

@Module({
  providers: [{ provide: REDIS, useFactory: () => sharedRedis() }, KillSwitchService],
  exports: [KillSwitchService],
})
export class KillSwitchModule implements OnModuleDestroy {
  onModuleDestroy(): void {
    closeSharedRedis();
  }
}
