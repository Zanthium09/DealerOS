import { Module, OnModuleDestroy } from '@nestjs/common';
import { closeSharedRedis, sharedRedis } from '../redis';
import { ThrottleService } from './throttle.service';
import { REDIS } from './throttle.tokens';

@Module({
  providers: [{ provide: REDIS, useFactory: () => sharedRedis() }, ThrottleService],
  exports: [ThrottleService],
})
export class ThrottleModule implements OnModuleDestroy {
  onModuleDestroy(): void {
    closeSharedRedis();
  }
}
