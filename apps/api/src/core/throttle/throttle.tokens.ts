// Split out from throttle.module.ts on purpose: throttle.service.ts needs this
// token, and throttle.module.ts needs the service. Importing the token FROM the
// module file makes a circular require — in CommonJS that resolves to a
// partially-populated module object at the exact moment the `@Inject(...)` decorator
// runs (decorators run at class-definition time, synchronously, during that circular
// require), so the token silently comes back `undefined` and Nest fails with
// "Nest can't resolve dependencies" for a provider that looks fine at a glance.
// No import cycle, no bug. (Same class of bug core/webhooks hit first — see
// webhooks.tokens.ts.)
export const REDIS = 'THROTTLE_REDIS';
