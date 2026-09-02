import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApprovalError } from '../approval/approval.service';
import { DraftingError } from '../drafting/variables';
import { ChannelPausedError } from '../killswitch/killswitch.service';
import { StagingSendBlockedError } from '../killswitch/staging-guard';
import { EmailProviderError } from '../../providers/email/email.provider';
import { EmailSendError } from '../../modules/outreach-email/send.service';
import { InboundEmailError } from '../../modules/outreach-email/inbound.service';
import { UnsubscribeError } from '../../modules/outreach-email/unsubscribe-endpoint.service';

/**
 * Every domain error in this app was a plain `extends Error`, and Nest's default
 * behaviour for a non-HttpException is a bare 500 "Internal server error" with the
 * message thrown away. So a dealer with no email address, a draft that was already
 * decided, a paused channel and a genuine crash were indistinguishable from the
 * dashboard — all of them read "Internal server error".
 *
 * Mapping them here rather than try/catching in each controller is deliberate: the
 * controllers are not the only callers (schedulers and the BullMQ worker throw the
 * same types), and a new controller should not be able to reintroduce the bug by
 * forgetting a catch block.
 *
 * A 4xx here means "the request was understood and refused for a stated business
 * reason" — those are expected and logged at debug. Anything unmapped stays a 500
 * and is logged with its stack, because it is a real bug.
 */
const STATUS_BY_ERROR: [new (...args: never[]) => Error, HttpStatus][] = [
  // The draft was already approved/rejected — a conflicting state, not a bad request.
  [ApprovalError, HttpStatus.CONFLICT],
  [EmailSendError, HttpStatus.UNPROCESSABLE_ENTITY],
  [DraftingError, HttpStatus.UNPROCESSABLE_ENTITY],
  [UnsubscribeError, HttpStatus.BAD_REQUEST],
  [InboundEmailError, HttpStatus.BAD_REQUEST],
  // Kill switch / staging guard: the request is fine, the channel is closed.
  [ChannelPausedError, HttpStatus.SERVICE_UNAVAILABLE],
  [StagingSendBlockedError, HttpStatus.FORBIDDEN],
  // Upstream said no. 502 keeps it honestly separate from our own bugs.
  [EmailProviderError, HttpStatus.BAD_GATEWAY],
];

/** Structural, so this file does not need @types/express (not a dependency here). */
type JsonResponse = { status(code: number): { json(body: object): unknown } };

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DomainExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<JsonResponse>();
    const req = ctx.getRequest<{ method?: string; url?: string }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(normalize(exception.getResponse(), status, exception.message));
      return;
    }

    const mapped = STATUS_BY_ERROR.find(([type]) => exception instanceof type);
    const message = exception instanceof Error ? exception.message : String(exception);

    if (mapped) {
      const [type, status] = mapped;
      this.logger.debug(`${req?.method} ${req?.url} → ${status} ${type.name}: ${message}`);
      res.status(status).json({ statusCode: status, error: type.name, message });
      return;
    }

    // Genuinely unexpected. Log the stack — this is the only branch that should
    // ever produce "Internal server error", and now it means what it says.
    this.logger.error(
      `${req?.method} ${req?.url} → unhandled ${exception instanceof Error ? exception.name : typeof exception}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message,
    });
  }
}

function normalize(body: unknown, status: number, fallback: string): object {
  if (body && typeof body === 'object') return body as object;
  return { statusCode: status, message: typeof body === 'string' ? body : fallback };
}
