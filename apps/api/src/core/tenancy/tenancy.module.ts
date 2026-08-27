import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenancyMiddleware } from './tenancy.middleware';
import { withTenancy } from './tenancy';

// The only Prisma client feature code may inject. It is scoped; the bare PrismaClient
// is not, so it is deliberately not provided anywhere (§1.3).
export const PRISMA = 'PRISMA';

@Global()
@Module({
  providers: [{ provide: PRISMA, useFactory: () => withTenancy(new PrismaClient()) }],
  exports: [PRISMA],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // '{*splat}' — express 5 / path-to-regexp 8 wildcard syntax.
    consumer.apply(TenancyMiddleware).forRoutes('{*splat}');
  }
}
