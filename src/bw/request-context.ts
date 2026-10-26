// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE). Changes for coBWeb are marked "coBWeb:".

/**
 * Request-scoped BW client, used by the HTTP transport.
 *
 * Under principal propagation the client carries one user's identity, so it cannot be
 * a module-level singleton. Rather than thread a parameter through every tool and
 * helper, the active client lives in an AsyncLocalStorage for the duration of the
 * request. `createClientFromEnv()` consults it (see bw-client.ts), which is what lets
 * the ~30 existing in-tool "fresh session" call sites keep working unchanged while
 * still running as the calling user.
 *
 * stdio does not use this: there is one process, one user, one set of credentials.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BwClient } from './client.js'; // coBWeb: renamed from bw-client.js

const storage = new AsyncLocalStorage<BwClient>();

export function runWithClient<T>(client: BwClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(client, fn);
}

/** The active request's client, or undefined under stdio. */
export function currentClient(): BwClient | undefined {
  return storage.getStore();
}
