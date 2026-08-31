import IORedis from 'ioredis';

// One shared, lazily-created connection for everything that does plain (non-blocking)
// Redis commands — throttle counters, the kill switch, BullMQ's Queue side. A BullMQ
// Worker gets its OWN connection wherever one is created (see webhooks/webhook-queue.ts):
// a Worker blocks its connection on stream reads, so sharing it with anything else
// would stall that other thing. ponytail: no pool, this app's Redis traffic is tiny.
let shared: IORedis | undefined;

export function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://localhost:6380';
}

export function sharedRedis(): IORedis {
  if (!shared) shared = new IORedis(redisUrl(), { maxRetriesPerRequest: null });
  return shared;
}

/** A fresh, independent connection — for a BullMQ Worker, or a test simulating "a new process". */
export function newRedisConnection(): IORedis {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null });
}

/**
 * Closes the shared connection so nothing keeps a test process (or a real shutdown)
 * alive on an open socket. Safe to call more than once — every module that uses
 * `sharedRedis()` calls this from its own `onModuleDestroy`, and ioredis's
 * `disconnect()` is a no-op once already closed.
 */
export function closeSharedRedis(): void {
  shared?.disconnect();
  shared = undefined;
}

/**
 * A BullMQ Queue or Worker that never gets an 'error' listener crashes the whole
 * process on the first transient Redis hiccup — Node's EventEmitter rethrows an
 * 'error' event as an uncaught exception when nothing is listening for it, and a
 * connection racing its own shutdown (an in-flight blocking read on a socket that
 * `onModuleDestroy` just closed) is exactly the kind of transient error this hits.
 * Found via an intermittent ~15% boot-check crash — "Emitted 'error' event on Worker
 * instance" — while adding a second Worker to a module that already had one; the gap
 * was pre-existing on every BullMQ instance in this codebase, just less likely to be
 * hit with only one Worker in the process. One helper, called at every Queue/Worker
 * construction site, rather than three copies of the same `.on('error', ...)`.
 */
export function logRedisErrors(emitter: { on(event: 'error', cb: (err: Error) => void): unknown }, label: string): void {
  emitter.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[${label}] Redis connection error (non-fatal, BullMQ retries internally):`, err.message);
  });
}
