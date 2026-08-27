// Findings 7 and 9 — the two places this codebase let NODE_ENV decide something
// that must not depend on NODE_ENV.
//
// 7: .env.example told operators "the dev fallbacks in the code are refused when
//    NODE_ENV=production — the process fails to start". No such check existed. Only
//    ALLOW_DEV_SECRETS was consulted, and .env ships ALLOW_DEV_SECRETS=1, so an
//    operator who copied .env into production booted an API signing tenant and
//    PLATFORM sessions with strings published in this git repository.
// 9: the session cookies' Secure flag was `NODE_ENV === 'production' ? ... : ''`,
//    the exact pattern the secret code above deliberately refuses, in the same
//    codebase. A deploy that forgets NODE_ENV shipped them without Secure.
import '../support';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { signTenantSession } from '../../src/core/auth/tenant-session';
import { signPlatformSession } from '../../src/core/platform-admin/platform-session';
import { newSecret } from '../../src/core/platform-admin/totp';
import * as tenantHttp from '../../src/core/auth/http';
import * as adminHttp from '../../src/core/platform-admin/http';

/** Runs `fn` with the named env vars replaced (undefined = deleted), then restores. */
async function withEnv(patch: Record<string, string | undefined>, fn: () => unknown) {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Every secret this codebase can fall back on, and the call that forces it to be read.
const SECRETS: [name: string, use: () => unknown][] = [
  ['AUTH_SESSION_SECRET', () => signTenantSession({ userId: 'u', organizationId: 'o', role: 'r' })],
  ['ADMIN_SESSION_SECRET', () => signPlatformSession({ adminUserId: 'a', role: 'r' })],
  ['ADMIN_MFA_KEY', () => newSecret('a@platform.test')],
];

describe('dev secret fallbacks (finding 7)', () => {
  for (const [name, use] of SECRETS) {
    test(`${name} is refused under NODE_ENV=production even with ALLOW_DEV_SECRETS=1`, async () => {
      // The failure .env.example describes: someone copies .env, which carries
      // ALLOW_DEV_SECRETS=1, and trusts the file's promise about production.
      await withEnv({ [name]: undefined, NODE_ENV: 'production', ALLOW_DEV_SECRETS: '1' }, () =>
        assert.rejects(async () => use(), /required in production/),
      );
    });

    test(`${name} is refused without ALLOW_DEV_SECRETS even when NODE_ENV is unset`, async () => {
      // The other half: the deploy that forgets NODE_ENV must fail too. Both layers
      // exist so neither one carries the whole weight.
      await withEnv({ [name]: undefined, NODE_ENV: undefined, ALLOW_DEV_SECRETS: undefined }, () =>
        assert.rejects(async () => use(), /is required/),
      );
    });

    test(`${name} still falls back for local development`, async () => {
      await withEnv({ [name]: undefined, NODE_ENV: undefined, ALLOW_DEV_SECRETS: '1' }, async () => {
        assert.ok(await use());
      });
    });
  }

  test('the process refuses to start, not merely the first login', async () => {
    // "The process fails to start" was the claim; the secrets are read lazily, so
    // without main.ts asserting them at boot a misconfigured API would have listened
    // happily and only failed on the first request. This runs the real entrypoint.
    const main = join(__dirname, '../../src/main.js');
    assert.ok(existsSync(main), `compiled entrypoint missing: ${main}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_DEV_SECRETS: '1',
    };
    delete env.AUTH_SESSION_SECRET;
    const run = spawnSync(process.execPath, [main], { env, encoding: 'utf8', timeout: 30_000 });

    assert.notEqual(run.status, 0, 'the API booted without AUTH_SESSION_SECRET in production');
    assert.match(`${run.stderr}${run.stdout}`, /AUTH_SESSION_SECRET is required in production/);
  });

  test('ALLOW_DEV_SECRETS is announced loudly at boot', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(join(__dirname, '../../../src/main.ts'), 'utf8'),
    );
    assert.match(src, /ALLOW_DEV_SECRETS/);
    assert.match(src, /console\.warn/);
  });
});

describe('session cookies are Secure unless explicitly told otherwise (finding 9)', () => {
  const capture = (http: { setSessionCookie: typeof tenantHttp.setSessionCookie }) => {
    let header = '';
    http.setSessionCookie({ setHeader: (_n, v) => (header = String(v)) }, 'c', 'v', 60);
    return header;
  };

  for (const [flow, http] of [
    ['tenant', tenantHttp],
    ['platform admin', adminHttp],
  ] as const) {
    test(`${flow}: Secure is set when NODE_ENV is unset — the deploy that forgot it`, async () => {
      await withEnv({ NODE_ENV: undefined, ALLOW_DEV_SECRETS: undefined }, () => {
        assert.match(capture(http), /; Secure/);
        let cleared = '';
        http.clearSessionCookie({ setHeader: (_n, v) => (cleared = String(v)) }, 'c');
        assert.match(cleared, /; Secure/);
      });
    });

    test(`${flow}: Secure is set in production too`, async () => {
      await withEnv({ NODE_ENV: 'production', ALLOW_DEV_SECRETS: undefined }, () => {
        assert.match(capture(http), /; Secure/);
      });
    });

    test(`${flow}: only ALLOW_DEV_SECRETS=1 drops it`, async () => {
      await withEnv({ NODE_ENV: undefined, ALLOW_DEV_SECRETS: '1' }, () => {
        assert.ok(!capture(http).includes('Secure'));
      });
    });
  }
});
