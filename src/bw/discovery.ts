/**
 * Media types from the discovery document, loaded once per process. Based on bw-modeling-mcp
 * (https://github.com/dnic-dev/bw-modeling-mcp), Copyright (c) 2026 dnic-dev, MIT License (see
 * NOTICE). The client's MEDIA_TYPES map starts with compiled-in
 * fallbacks; discovery replaces them with the versions this system serves. Cleared on failure so a
 * transient error does not pin the fallbacks for the life of the process.
 */
import type { BwClient } from './client.js';
import { log } from '../log.js';

let discovery: Promise<void> | null = null;

export function ensureMediaTypes(client: BwClient): Promise<void> {
  if (!discovery) {
    discovery = client.loadMediaTypes().catch((err) => {
      discovery = null;
      log('warn', `discovery failed, using fallback media types (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    });
  }
  return discovery;
}

/** Test seam. */
export function resetMediaTypes(): void {
  discovery = null;
}
