#!/usr/bin/env node
// Prints the tool list of the whole catalog (every tool, every flag on, implemented or not) in the
// form {"initialize": {"instructions": ...}, "tools": [...]}.
// Usage: npm run build && node scripts/tools-list.mjs [profile] > tools.json
import { fullConfig, PROFILES } from '../dist/config.js';
import { buildSurface } from '../dist/server/surface.js';
import { buildInstructions } from '../dist/server/instructions.js';

const profile = process.argv[2] ?? 'full';
if (!(profile in PROFILES)) {
  console.error(`unknown profile ${profile}; use one of ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
const config = { ...fullConfig(), profile, tools: [...PROFILES[profile]] };
const offered = buildSurface(config, { implemented: 'all' });
const tools = offered.map((o) => o.definition);
const out = { initialize: { instructions: buildInstructions(tools.map((t) => t.name)) }, tools };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
