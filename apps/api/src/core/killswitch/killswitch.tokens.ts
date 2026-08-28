// See throttle.tokens.ts / webhooks.tokens.ts for why this token lives in its own
// file rather than inside killswitch.module.ts: killswitch.service.ts importing it
// from the module file is a circular require, which silently hands `@Inject(REDIS)`
// `undefined` instead of throwing.
export const REDIS = 'KILLSWITCH_REDIS';
