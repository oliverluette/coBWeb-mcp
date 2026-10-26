/**
 * Server configuration from environment variables.
 *
 * The BW connection variables (BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT, BW_COOKIE_FILE,
 * BW_PLATFORM) are read by the BW client itself. Everything coBWeb
 * adds is prefixed COBWEB_. Secrets are never part of this object.
 */
import { BW_TYPES, isBwType, type BwType } from './catalog/types.js';

export const PROFILES = {
  modeling: ['bw_search', 'bw_read', 'bw_context', 'bw_describe', 'bw_write', 'bw_activate', 'bw_transport', 'bw_system'],
  analysis: ['bw_search', 'bw_read', 'bw_context', 'bw_data'],
  operations: ['bw_search', 'bw_read', 'bw_monitor', 'bw_run', 'bw_system'],
  full: [
    'bw_search',
    'bw_read',
    'bw_context',
    'bw_describe',
    'bw_write',
    'bw_activate',
    'bw_data',
    'bw_monitor',
    'bw_run',
    'bw_transport',
    'bw_system',
  ],
} as const satisfies Record<string, readonly string[]>;

export type ProfileName = keyof typeof PROFILES;

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Config {
  profile: ProfileName;
  /** Tools requested by profile or COBWEB_TOOLS, in catalog order. */
  tools: string[];
  /** Object types the server offers (COBWEB_TYPES), all by default. */
  types: BwType[];
  allowWrites: boolean;
  allowData: boolean;
  allowExecute: boolean;
  allowedPackages: string[];
  allowedInfoAreas: string[];
  denyActions: string[];
  maxResultChars: number;
  logLevel: LogLevel;
  /** File that receives one JSON line per write (COBWEB_AUDIT_FILE); no audit when unset. */
  auditFile?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const profileRaw = (env.COBWEB_PROFILE ?? 'modeling').trim().toLowerCase();
  if (!(profileRaw in PROFILES)) {
    throw new ConfigError(
      `COBWEB_PROFILE="${profileRaw}" is not a profile. Use one of: ${Object.keys(PROFILES).join(', ')}.`,
    );
  }
  const profile = profileRaw as ProfileName;

  const allTools: readonly string[] = PROFILES.full;
  let tools: string[] = [...PROFILES[profile]];
  const explicitTools = list(env.COBWEB_TOOLS);
  if (explicitTools.length > 0) {
    const unknown = explicitTools.filter((t) => !allTools.includes(t));
    if (unknown.length > 0) {
      throw new ConfigError(`COBWEB_TOOLS names unknown tools: ${unknown.join(', ')}. Known: ${allTools.join(', ')}.`);
    }
    tools = allTools.filter((t) => explicitTools.includes(t));
  }

  let types: BwType[] = [...BW_TYPES];
  const explicitTypes = list(env.COBWEB_TYPES).map((t) => t.toUpperCase());
  if (explicitTypes.length > 0) {
    const unknown = explicitTypes.filter((t) => !isBwType(t));
    if (unknown.length > 0) {
      throw new ConfigError(`COBWEB_TYPES names unknown types: ${unknown.join(', ')}. Known: ${BW_TYPES.join(', ')}.`);
    }
    types = BW_TYPES.filter((t) => explicitTypes.includes(t));
  }

  const maxRaw = env.COBWEB_MAX_RESULT_CHARS?.trim();
  const maxResultChars = maxRaw ? Number(maxRaw) : 20_000;
  if (!Number.isInteger(maxResultChars) || maxResultChars < 2_000 || maxResultChars > 500_000) {
    throw new ConfigError('COBWEB_MAX_RESULT_CHARS must be an integer between 2000 and 500000.');
  }

  const level = (env.COBWEB_LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!['error', 'warn', 'info', 'debug'].includes(level)) {
    throw new ConfigError('COBWEB_LOG_LEVEL must be one of: error, warn, info, debug.');
  }

  const packages = list(env.COBWEB_ALLOWED_PACKAGES);
  const infoAreas = list(env.COBWEB_ALLOWED_INFOAREAS);

  return {
    profile,
    tools,
    types,
    allowWrites: flag(env.COBWEB_ALLOW_WRITES),
    allowData: flag(env.COBWEB_ALLOW_DATA),
    allowExecute: flag(env.COBWEB_ALLOW_EXECUTE),
    allowedPackages: packages.length > 0 ? packages.map((p) => p.toUpperCase()) : ['$TMP'],
    allowedInfoAreas: infoAreas.length > 0 ? infoAreas.map((a) => a.toUpperCase()) : ['*'],
    denyActions: list(env.COBWEB_DENY_ACTIONS),
    maxResultChars,
    logLevel: level as LogLevel,
    ...(env.COBWEB_AUDIT_FILE?.trim() ? { auditFile: env.COBWEB_AUDIT_FILE.trim() } : {}),
  };
}

/** Configuration with every flag on: used to measure the full catalog. */
export function fullConfig(): Config {
  return {
    ...loadConfig({ COBWEB_PROFILE: 'full' }),
    allowWrites: true,
    allowData: true,
    allowExecute: true,
  };
}
