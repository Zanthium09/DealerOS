export { OutreachEmailModule } from './outreach-email.module';
export { OutreachEmailService } from './outreach-email.service';
export type { ColdOutreachResult } from './outreach-email.service';
export { OutreachEmailController } from './outreach-email.controller';
export { ColdDraftService, alreadyDrafted } from './cold-draft.service';
export { EmailSendService, EmailSendError, SOURCE_MODULE, EMAIL_SEND_CONFIG } from './send.service';
export type { EmailSendConfig } from './send.service';
export { SequenceService, SEQUENCE_QUEUE_NAME, SEQUENCE_STEPS, DEFAULT_SEQUENCE_STEPS_MS } from './sequence.service';
export type { SequenceSteps } from './sequence.service';
export { OutreachEmailWebhookService } from './webhook.service';
export { InboundEmailService, InboundEmailError } from './inbound.service';
export { UnsubscribeEndpointService, UnsubscribeError } from './unsubscribe-endpoint.service';
export { eligibleForColdOutreach } from './eligibility';
export { currentConsentState, isEligibleForEmail, writeConsent } from './consent';
export { classifyReply } from './reply-classify';
export type { ReplyClassification, InboundEmail } from './reply-classify';
export { buildMessageId, parseMessageId, findThreadedMessageId } from './message-id';
export { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl, unsubscribeHeaders } from './unsubscribe';
export { transitionPipelineStage } from './pipeline';
export {
  SEND_THROTTLE,
  KILL_SWITCH,
  AlwaysAllowThrottle,
  NeverPausedKillSwitch,
} from './ports';
export type { SendThrottle, KillSwitch, SendThrottleDecision } from './ports';
