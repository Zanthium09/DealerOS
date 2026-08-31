// Same reason webhooks.tokens.ts / throttle.tokens.ts exist: schedule.service.ts and
// schedule.module.ts must not import tokens from each other's file — that circular
// require silently hands @Inject(...) `undefined` under CommonJS. Two DI boot bugs of
// exactly this shape already shipped this project before the fix became the rule.
export const SCHEDULE_QUEUE = 'OUTREACH_SCHEDULE_QUEUE';
export const SCHEDULE_QUEUE_NAME = 'outreach-schedule';
