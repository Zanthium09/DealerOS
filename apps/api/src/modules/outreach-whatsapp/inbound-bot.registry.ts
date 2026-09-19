import { Injectable, Logger } from '@nestjs/common';

export type InboundBotResult = {
  /** The bot dealt with this message, so the human inbox need not. */
  handled: boolean;
  /** The bot wants a person to take over (the dealer asked, or it could not proceed). */
  needsHuman?: boolean;
  reason?: string;
};

export interface InboundBot {
  handle(input: { dealerId: string; text: string }): Promise<InboundBotResult>;
}

/**
 * Lets a module that sits ABOVE this one (the ordering bot, M8) take an inbound message
 * without this module importing it — the dependency runs one way. Bots are asked in
 * registration order; the first that handles the message wins.
 */
@Injectable()
export class InboundBotRegistry {
  private readonly logger = new Logger(InboundBotRegistry.name);
  private readonly bots: InboundBot[] = [];

  register(bot: InboundBot): void {
    this.bots.push(bot);
  }

  /** A bot failing must never fail the webhook: Meta would retry, and the retry could
   *  send the dealer a second reply. The message stays in the human inbox instead. */
  async dispatch(input: { dealerId: string; text: string }): Promise<InboundBotResult> {
    for (const bot of this.bots) {
      try {
        const r = await bot.handle(input);
        if (r.handled) return r;
      } catch (err) {
        this.logger.error(`inbound bot failed, leaving the message for a person: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { handled: false };
  }
}
