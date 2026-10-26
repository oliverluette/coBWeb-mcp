/**
 * Recording of modeling documents for test fixtures (development aid).
 *
 * With COBWEB_RECORD_DIR set, every successful GET below /sap/bw/modeling/ is written to that
 * folder, one file per path. Only metadata is recorded: data previews and request monitors
 * are skipped, and request headers (credentials, cookies) are never written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = /datapreview|\/data\b|\/requests?\b|\/monitor/i;

export function recordName(path: string): string {
  const clean = path
    .replace(/^\/sap\/bw\/modeling\//, '')
    .replace(/[?&](forceCacheUpdate|sap-client)=[^&]*/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${clean.slice(0, 180)}.xml`;
}

export function record(path: string, body: string, dir: string | undefined = process.env.COBWEB_RECORD_DIR): void {
  if (!dir || !path.startsWith('/sap/bw/modeling/') || SKIP.test(path)) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, recordName(path)), body, 'utf8');
  } catch {
    // A recording problem must never break a read.
  }
}
