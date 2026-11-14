// Lifecycle entrypoint for the forge (github-core-clone-01).
//
// The forge itself is built by createApp() in app.ts; this file only wires it
// into a make.fun trial, following the lifecycle in the kit's RULES.txt:
//
//   1. Bind an ephemeral port (port 0 — the kernel picks one; never 8080,
//      where the suite listens).
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register so the suite knows
//      where to dial us.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then
//      shut the server down and exit 0.
//
// A program that exits, crashes, or never registers before the boot budget
// ends leaves no working forge and scores 0, so registration is retried
// until the env accepts us, and only an explicit {"done": true} ends the
// trial — a failed poll is treated as "not done yet", never as a reason to
// quit. Nothing time- or randomness-derived is ever sent in a request.
//
// Node 22, stdlib only.

import { createApp } from './app.ts';

const POLL_INTERVAL_MS = 1000;
const REGISTER_RETRY_MS = 500;
const REGISTER_DEADLINE_MS = 120_000;
const REGISTER_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2000;

function envBaseUrl(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim();
  if (raw === '') {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }
  return raw.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST {"port": n} to the env's /register; true only on a 2xx answer. */
async function tryRegister(base: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** GET the env's /done; true only on an explicit {"done": true}. */
async function tryPollDone(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/done`, { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  let base: string;
  try {
    base = envBaseUrl();
  } catch (err) {
    process.stderr.write(`[lifecycle] ${(err as Error).message}\n`);
    return 1;
  }

  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      if (addr !== null && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('could not determine the bound port'));
      }
    });
  });
  process.stderr.write(`[lifecycle] forge listening on port ${port}\n`);

  // Register with the env, retrying while the boot budget lasts. The suite
  // only starts driving the forge once it has our port, so giving up early
  // would forfeit the trial; a refused connection while the env is still
  // coming up is transient and worth retrying.
  const startedAt = Date.now();
  let registered = false;
  while (Date.now() - startedAt < REGISTER_DEADLINE_MS) {
    registered = await tryRegister(base, port);
    if (registered) break;
    await sleep(REGISTER_RETRY_MS);
  }
  if (!registered) {
    process.stderr.write('[lifecycle] register failed: env never accepted our port\n');
    server.close();
    return 1;
  }
  process.stderr.write('[lifecycle] registered with env\n');

  // Wait for the suite to finish and write its export. Poll once a second;
  // a failed poll just means "not done yet".
  for (;;) {
    if (await tryPollDone(base)) break;
    await sleep(POLL_INTERVAL_MS);
  }

  process.stderr.write('[lifecycle] trial done, shutting down\n');
  // Close gracefully, but never hang past the grace period: a trial whose
  // program is still running at the wall scores 0 on every column.
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    sleep(SHUTDOWN_GRACE_MS),
  ]);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `[lifecycle] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
