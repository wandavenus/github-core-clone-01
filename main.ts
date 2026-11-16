// Entry point for the forge: owns the conversation with the harness env.
//
// The env is a second server started next to this one. This file's whole job
// is to tell the env where the forge ended up listening, then stay alive
// until the env has finished driving it:
//
//   - the env's origin arrives in MAKEFUN_ENV_URL; with no origin there is
//     nobody to register with, so the process exits 1 immediately;
//   - the forge binds port 0 and the kernel assigns a free port (8080 is the
//     env's own port and is never used here);
//   - POST /register hands that port to the env, which dials the forge back
//     at the address the request came from; the first registration wins, so
//     a 409 answer is accepted as success too;
//   - GET /done is polled until it answers {"done": true};
//   - then the server closes and the process exits 0.
//
// Both env calls are retried with a growing delay while the env may still be
// starting; a 400 or 405 from /register is a contract error and is fatal.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set; nowhere to register');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Delay before the next attempt: doubles from FIRST_RETRY_MS, capped.
function backoff(failures: number): number {
  const grown = FIRST_RETRY_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_RETRY_MS, grown);
}

async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const reply = await fetch(envOrigin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = new Error('register refused with HTTP ' + reply.status + ': ' + (await reply.text()));
      }
    } catch {
      // Network trouble or a timeout: the env may not be up yet; retry below.
    }
    if (fatal !== null) throw fatal;
    await pause(backoff(failures));
    failures += 1;
  }
}

async function holdUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(envOrigin + '/done', {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        if (typeof payload === 'object' && payload !== null && (payload as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // A failed poll only means "not done yet"; keep polling.
    }
    await pause(backoff(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const bound = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('forge did not bind a TCP port'));
      } else {
        resolve(address.port);
      }
    });
  });
  const port = await bound;
  console.log('[forge] listening on port ' + port);

  await announcePort(port);
  console.log('[forge] registered with the env; serving until done');

  await holdUntilDone();
  server.close();
  console.log('[forge] env reports done; exiting');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('[forge] ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
