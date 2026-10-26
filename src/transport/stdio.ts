#!/usr/bin/env node
/**
 * stdio entry point: one process, one user, one BW system.
 *
 * The platform is detected before the handshake when a BW connection is configured. Without
 * BW_URL the server still starts, so the tool list can be inspected and measured; BW calls
 * then fail with a configuration hint.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClientFromEnv } from '../bw/client.js';
import { ensureMediaTypes } from '../bw/discovery.js';
import { ensurePlatform } from '../bw/platform.js';
import { loadConfig } from '../config.js';
import { log, setLogLevel } from '../log.js';
import { createServer } from '../server/create-server.js';
import { VERSION } from '../version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  if (process.env.BW_URL) {
    try {
      const client = createClientFromEnv();
      const profile = await ensurePlatform(client);
      log('info', `platform: ${profile.detail}`);
      await ensureMediaTypes(client);
    } catch (err) {
      log('warn', `platform detection skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    log('warn', 'BW_URL is not set; tools that call BW will report a configuration error.');
  }
  const server = createServer({ config });
  await server.connect(new StdioServerTransport());
  log('info', `coBWeb-mcp ${VERSION} started (profile ${config.profile})`);
}

main().catch((err) => {
  process.stderr.write(`[cobweb] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
