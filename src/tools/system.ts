/**
 * bw_system: system profile and release of a lock this server still holds.
 */
import type { BwClient } from '../bw/client.js';
import { ensurePlatform, parseSysProps } from '../bw/platform.js';
import { BW_TYPES, TYPE_INFO, isBwType, type BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError } from '../format/errors.js';
import { VERSION } from '../version.js';
import type { HandlerContext } from './context.js';

const UNLOCKABLE: ReadonlySet<BwType> = new Set(['AREA', 'IOBJ', 'ADSO', 'HCPR', 'TRCS', 'TRFN', 'DTPA', 'ALVL']);

function onOff(on: boolean, flag: string): string {
  return on ? 'on' : `off (${flag})`;
}

export function serverSection(ctx: HandlerContext): string[] {
  const c = ctx.config;
  const writes = c.allowWrites
    ? `on; packages ${c.allowedPackages.join(', ')}; InfoAreas ${c.allowedInfoAreas.join(', ')}`
    : onOff(false, 'COBWEB_ALLOW_WRITES');
  return [
    'Server',
    `  coBWeb-mcp ${VERSION}, profile ${c.profile}`,
    `  Tools:            ${ctx.offered.join(', ')}`,
    `  Object types:     ${c.types.length === BW_TYPES.length ? 'all' : c.types.join(' ')}`,
    `  Writes:           ${writes}`,
    `  Data access:      ${onOff(c.allowData, 'COBWEB_ALLOW_DATA')}`,
    `  Runtime actions:  ${onOff(c.allowExecute, 'COBWEB_ALLOW_EXECUTE')}`,
    `  Denied actions:   ${c.denyActions.length > 0 ? c.denyActions.join(', ') : 'none'}`,
    `  Result limit:     ${c.maxResultChars.toLocaleString('en-US')} characters`,
    `  Audit log:        ${c.auditFile ? 'on (COBWEB_AUDIT_FILE)' : 'off (COBWEB_AUDIT_FILE)'}`,
  ];
}

async function profile(ctx: HandlerContext): Promise<string> {
  const client = ctx.client();
  const platform = await ensurePlatform(client as unknown as BwClient);
  const { body } = await client.get('/sap/bw/modeling/repo/is/systeminfo', 'application/xml');
  const props = parseSysProps(body);
  const changeable = body.match(/bwChangeable="([^"]*)"/)?.[1] ?? '?';
  const basis = body.match(/basisChangeable="([^"]*)"/)?.[1] ?? '?';
  const db = body.match(/<dbInfo:name>([^<]+)</)?.[1] ?? '?';
  const host = (() => {
    try {
      return new URL(process.env.BW_URL ?? '').host;
    } catch {
      return '?';
    }
  })();

  const out = [
    'System',
    `  Platform:         ${platform.platform === 'bw4' ? 'SAP BW/4HANA' : 'classic SAP BW (7.5 or lower)'} (${platform.detail})`,
    `  Host:             ${host}`,
    `  Logical system:   ${props['system.logsys'] ?? '?'}`,
    `  Release:          ${props['system.server_version'] ?? '?'}`,
    `  Database:         ${db}`,
    `  Language:         ${props['system.language'] ?? '?'}`,
    `  Changeable:       BW ${changeable}, Basis ${basis}`,
    `  Planning:         ${props['bw.planning_supported'] === 'X' ? 'supported' : 'not supported'}`,
  ];

  if (platform.collections.size > 0) {
    // Types without a REST collection of their own (ROLE) are read through other resources.
    const published = ctx.config.types.filter((t) => TYPE_INFO[t].collections.length === 0 || TYPE_INFO[t].collections.some((c) => platform.collections.has(c)));
    const missing = ctx.config.types.filter((t) => !published.includes(t));
    out.push('Object types (REST API of this system)');
    out.push(`  Published:        ${published.join(' ') || 'none'}`);
    if (missing.length > 0) out.push(`  Not published:    ${missing.join(' ')}`);
  }
  out.push(...serverSection(ctx));
  return out.join('\n');
}

async function unlock(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const type = typeof args.type === 'string' ? args.type.toUpperCase() : '';
  const name = typeof args.name === 'string' ? args.name.trim().toUpperCase() : '';
  if (!type || !name) {
    throw new ToolError('validation', 'unlock needs type and name.', 'Example: bw_system(action="unlock", type="ADSO", name="ZSALES01").');
  }
  if (!isBwType(type) || !UNLOCKABLE.has(type)) {
    throw new ToolError('not_implemented', `unlock does not support type ${type}.`, `Supported: ${[...UNLOCKABLE].join(', ')}.`);
  }
  await ctx.client().unlock(TYPE_INFO[type].collections[0], name);
  return `Unlocked ${type} ${name}: the lock this server held is released. A lock held by another user or session is not affected.`;
}

export async function bwSystem(args: JsonObject, ctx: HandlerContext): Promise<string> {
  return args.action === 'unlock' ? unlock(args, ctx) : profile(ctx);
}
