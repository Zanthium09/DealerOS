import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { writeConsent } from './consent';
import { EmailSendConfig, EMAIL_SEND_CONFIG } from './send.service';
import { verifyUnsubscribeToken } from './unsubscribe';

export class UnsubscribeError extends Error {}

/** §6 — the endpoint the one-click link and header both point at. */
@Injectable()
export class UnsubscribeEndpointService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EMAIL_SEND_CONFIG) private readonly config: EmailSendConfig,
  ) {}

  async unsubscribe(token: string): Promise<void> {
    const claim = verifyUnsubscribeToken(this.config.unsubscribeSecret, token);
    if (!claim) throw new UnsubscribeError('invalid or tampered unsubscribe token');

    await runWithOrg(claim.organizationId, async () => {
      const dealer = await this.prisma.dealer.findFirst({ where: { id: claim.dealerId } });
      if (!dealer) throw new UnsubscribeError('dealer not found');

      await writeConsent(this.prisma, {
        organizationId: claim.organizationId,
        dealerId: claim.dealerId,
        channel: 'EMAIL',
        state: 'OPTED_OUT',
        source: 'EXPLICIT_UNSUBSCRIBE',
      });

      const email = await this.prisma.dealerEmail.findFirst({ where: { dealerId: claim.dealerId, isPrimary: true } });
      if (email) {
        await this.prisma.suppression.create({
          data: { email: email.address, reason: 'one-click unsubscribe' } as Prisma.SuppressionUncheckedCreateInput,
        });
      }
    });
  }
}
