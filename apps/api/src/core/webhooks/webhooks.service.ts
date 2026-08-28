import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PRISMA } from '../tenancy/tenancy.module';
import { ADAPTERS, WEBHOOK_QUEUE } from './webhooks.tokens';
import type { WebhookAdapter } from './webhook-adapter';

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ADAPTERS) private readonly adapters: Map<string, WebhookAdapter>,
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * §8 — the HTTP handler ONLY persists and enqueues. Signature verification runs on
   * the raw body BEFORE the parsed payload is trusted for anything (event id
   * extraction included, since a forged payload could otherwise smuggle a real
   * event's id and collide it into a no-op).
   */
  async ingest(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
    parsedBody: unknown,
  ): Promise<{ deduped: boolean }> {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new NotFoundException(`unknown webhook provider: ${provider}`);
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('missing raw request body');
    }
    if (!adapter.verifySignature(rawBody, headers)) {
      throw new UnauthorizedException('invalid webhook signature');
    }

    const eventId = adapter.extractEventId(parsedBody);
    if (!eventId) throw new BadRequestException('cannot determine event id for this payload');

    let webhookEventId: string;
    try {
      const created = await this.prisma.webhookEvent.create({
        data: { provider, providerEventId: eventId, payload: parsedBody as Prisma.InputJsonValue },
      });
      webhookEventId = created.id;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Meta and email providers both retry and duplicate (§8). Same providerEventId
        // twice: ack and return early, never process twice.
        return { deduped: true };
      }
      throw err;
    }

    await this.queue.add(
      'process',
      { webhookEventId },
      { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true },
    );
    return { deduped: false };
  }
}
