// Split out from webhooks.module.ts on purpose: webhooks.service.ts and
// webhooks.controller.ts need these tokens, and webhooks.module.ts needs the service
// and controller. Importing the tokens FROM the module file makes a circular
// require — in CommonJS that resolves to a partially-populated module object at the
// exact moment the `@Inject(...)` decorator runs (decorators run at class-definition
// time, synchronously, during that circular require), so the token silently comes
// back `undefined` and Nest fails with "argument at index [n] is available" for a
// provider that looks fine at a glance. No import cycle, no bug.
export const ADAPTERS = 'WEBHOOK_ADAPTERS';
export const WEBHOOK_QUEUE = 'WEBHOOK_QUEUE';
export const WORKER = 'WEBHOOK_WORKER';
export const WORKER_REDIS = 'WEBHOOK_WORKER_REDIS';
export const QUEUE_NAME = 'WEBHOOK_QUEUE_NAME';
