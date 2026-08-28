// Shared test support: env defaults, the throwaway database, and an HTTP client.
//
// No supertest, no jest: Node 22 has fetch and node:test. `pnpm test` provisions the
// database (test/run.mjs) and hands it to every child process as DATABASE_URL.

// Must be set before any module reads them. The two session secrets MUST differ —
// that difference is the structural guarantee the isolation tests exercise (§9A.2).
process.env.AUTH_SESSION_SECRET ??= 'test-tenant-session-secret-0123456789';
process.env.ADMIN_SESSION_SECRET ??= 'test-platform-session-secret-0123456789';
process.env.ADMIN_MFA_KEY ??= 'test-admin-mfa-encryption-key-0123456789';
// Rate limiting has its own test; everywhere else it must not interfere.
process.env.AUTH_LOGIN_MAX_ATTEMPTS ??= '10000';
process.env.ADMIN_LOGIN_MAX_ATTEMPTS ??= '10000';

import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

if (!/test/i.test(new URL(process.env.DATABASE_URL ?? 'postgres:///nope').pathname)) {
  throw new Error(
    'Tests refuse to run outside a database whose name contains "test". ' +
      'Run them with `pnpm test`, which provisions one.',
  );
}

/** Unscoped client — fixtures and assertions ABOUT scoping. Never the thing under test. */
export const raw = new PrismaClient();

export async function bootApp(): Promise<{ app: INestApplication; base: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // rawBody: true mirrors main.ts — §8 webhook tests need req.rawBody, which only
  // exists when the app is created with this option.
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

export type Res = {
  status: number;
  body: any;
  cookies: string[];
  header: (name: string) => string | null;
};

/** One request. Cookies are always passed explicitly — no jar quietly carrying a
 *  session between assertions that are supposed to be about which token is presented. */
export async function req(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; cookies?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Res> {
  const cookie = Object.entries(opts.cookies ?? {})
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return {
    status: res.status,
    body,
    cookies: res.headers.getSetCookie(),
    header: (name) => res.headers.get(name),
  };
}

/** Pull one named cookie's value out of a response. */
export function cookieValue(res: Res, name: string): string | null {
  for (const c of res.cookies) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}
