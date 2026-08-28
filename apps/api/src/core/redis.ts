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
