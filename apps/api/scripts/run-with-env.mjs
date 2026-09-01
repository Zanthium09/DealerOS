// `pnpm dev` / `pnpm start` run `nest start`, which — unlike `pnpm test` and
// `pnpm db:seed` — never loaded the root .env. Locally that meant AUTH_SESSION_SECRET
// and friends were simply unset, and the process died at boot with "AUTH_SESSION_SECRET
// is required" (see main.ts's assertSecretsUsable). `nest start` has no --env-file
// passthrough of its own, so this loads .env first (Node 20.6+'s built-in loader,
// no dependency) and then spawns whatever command was actually asked for.
//
//   node scripts/run-with-env.mjs nest start --watch
//
// Deploy hosts (Railway/Render) inject env vars directly into the process and ship
// no .env file at all — loadEnvFile throws ENOENT there, which must not be fatal.
try {
  process.loadEnvFile('../../.env');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));
