import type { PrismaClient } from '@prisma/client';
import { runWithOrg } from '../tenancy/tenancy';
import type { WebhookAdapter } from './webhook-adapter';

/**
 * §8 — all processing is async, off the HTTP request. Runs inside the BullMQ worker.
 *
 * Idempotent on retry: it re-reads the row and bails if `processedAt` is already set,
 * so a job that gets re-attempted after a crash (or a duplicate enqueue racing the
 * first one) does the work at most once. The InteractionEvent write and the
 * `processedAt` stamp happen in one transaction — a crash between them is impossible,
 * so there is no window where a retry would see "not yet processed" but the
 * InteractionEvent already exists.
 */
export async function processWebhookEvent(
  webhookEventId: string,
  prisma: PrismaClient,
  adapters: Map<string, WebhookAdapter>,
): Promise<void> {
  const row = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!row) return; // gone — nothing to do
  if (row.processedAt) return; // already handled by an earlier attempt

  const adapter = adapters.get(row.provider);
  if (!adapter) {
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { error: `no adapter registered for provider "${row.provider}"` },
    });
    return;
  }

  const interaction = adapter.toInteractionEvent(row.payload);

  if (!interaction) {
    // Recognised but nothing to log (e.g. a challenge/verification ping) — still done.
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), error: null },
    });
    return;
  }

  try {
    await runWithOrg(interaction.organizationId, () =>
      prisma.$transaction(async (tx) => {
        await tx.interactionEvent.create({ data: interaction });
        await tx.webhookEvent.update({
          where: { id: webhookEventId },
          data: { processedAt: new Date(), error: null },
        });
      }),
    );
  } catch (err) {
    // Best-effort error note so the row doesn't just vanish (§8's "must not vanish").
    // Left with processedAt still null: BullMQ will retry the job, and this function
    // is idempotent on retry.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookEvent
      .update({ where: { id: webhookEventId }, data: { error: message.slice(0, 2000) } })
      .catch(() => undefined);
    throw err;
  }
}
