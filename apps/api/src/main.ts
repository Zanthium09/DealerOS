import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { signTenantSession } from './core/auth/tenant-session';
import { signPlatformSession } from './core/platform-admin/platform-session';
import { newSecret } from './core/platform-admin/totp';

/**
 * Finding 7: .env.example promised "the process fails to start" if a secret is
 * missing in production, but each secret is only read on first use — so a
 * misconfigured deploy booted happily and signed real sessions with a fallback
 * published in this repository.
 *
 * Making the promise true, without a config framework: exercise each of the three
 * secrets once, here, before anything listens. No new exports and nothing to keep
 * in sync — these are the same entry points the request paths use, so if one of
 * them can produce a token at boot it can produce one at runtime, and if it cannot
 * the process dies now rather than at the first login.
 *
 * These three modules import jose and node:crypto and nothing else. AppModule is
 * loaded AFTER this runs, deliberately: importing @prisma/client loads the .env file
 * sitting next to schema.prisma, which in a development checkout would put the very
 * fallback secrets this check is looking for back into process.env.
 */
async function assertSecretsUsable(): Promise<void> {
  await signTenantSession({ userId: 'boot', organizationId: 'boot', role: 'boot' });
  await signPlatformSession({ adminUserId: 'boot', role: 'boot' });
  newSecret('boot@localhost');
}

function warnAboutDevSecrets(): void {
  if (process.env.ALLOW_DEV_SECRETS !== '1') return;
  const line = '='.repeat(78);
  // console, not Nest's Logger: this must be legible in a raw container log and
  // must not depend on anything the app has managed to wire up yet.
  console.warn(
    `\n${line}\n` +
      '  ALLOW_DEV_SECRETS=1 — DEVELOPMENT MODE.\n' +
      '  Missing session/MFA secrets fall back to values published in this git\n' +
      '  repository, and session cookies are sent WITHOUT the Secure flag.\n' +
      '  Anyone with the repo can mint a tenant or PLATFORM admin token.\n' +
      '  If you are seeing this in production, stop and unset it.\n' +
      `${line}\n`,
  );
}

async function bootstrap() {
  warnAboutDevSecrets();
  await assertSecretsUsable();
  const { AppModule } = await import('./app.module');
  // rawBody: true — §8 webhook signature verification must run over the exact bytes
  // received, before JSON parsing. Nest captures them onto req.rawBody alongside the
  // normal parsed req.body; nothing else in the app reads rawBody.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
