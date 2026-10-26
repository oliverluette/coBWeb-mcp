/**
 * The policy table: one operation class per tool action.
 *
 * It is the single source for three things: the check on every call, the filter that decides
 * which tools and actions `tools/list` offers, and the tests. Anything not listed here is
 * class `admin`, which no flag enables, so a forgotten entry never opens anything.
 */
import type { Config } from '../config.js';

export type OpClass = 'read' | 'data' | 'write' | 'activate' | 'execute' | 'transport' | 'admin';

/** Key: `tool` for single-purpose tools, `tool.action` for tools with an action parameter. */
export const POLICY: Readonly<Record<string, OpClass>> = {
  bw_search: 'read',
  bw_read: 'read',
  bw_context: 'read',
  bw_describe: 'read',
  'bw_write.create': 'write',
  'bw_write.update': 'write',
  'bw_write.delete': 'write',
  bw_activate: 'activate',
  'bw_data.query': 'data',
  'bw_data.preview': 'data',
  'bw_data.values': 'data',
  'bw_monitor.chain_status': 'read',
  'bw_monitor.chain_runs': 'read',
  'bw_monitor.chain_run': 'read',
  'bw_monitor.requests': 'read',
  'bw_monitor.request': 'read',
  'bw_monitor.remodeling': 'read',
  'bw_monitor.query_stats': 'read',
  'bw_run.run_dtp': 'execute',
  'bw_run.start_chain': 'execute',
  'bw_run.activate_request': 'execute',
  'bw_run.delete_request': 'execute',
  'bw_run.run_remodeling': 'execute',
  'bw_run.push_data': 'execute',
  'bw_transport.list': 'read',
  'bw_transport.create_task': 'transport',
  'bw_transport.assign': 'transport',
  'bw_transport.move': 'transport',
  'bw_system.profile': 'read',
  'bw_system.unlock': 'write',
};

/** Classes that never change anything in BW. Used for `readOnlyHint`. */
export const READ_ONLY_CLASSES: ReadonlySet<OpClass> = new Set(['read', 'data']);

export function opClassOf(tool: string, action?: string): OpClass {
  return POLICY[action ? `${tool}.${action}` : tool] ?? POLICY[tool] ?? 'admin';
}

/** Which flag enables which class. `admin` is reserved and never enabled. */
export function classEnabled(op: OpClass, config: Pick<Config, 'allowWrites' | 'allowData' | 'allowExecute'>): boolean {
  switch (op) {
    case 'read':
      return true;
    case 'data':
      return config.allowData;
    case 'write':
    case 'activate':
    case 'transport':
      return config.allowWrites;
    case 'execute':
      return config.allowExecute;
    default:
      return false;
  }
}

export function flagFor(op: OpClass): string {
  switch (op) {
    case 'data':
      return 'COBWEB_ALLOW_DATA';
    case 'execute':
      return 'COBWEB_ALLOW_EXECUTE';
    case 'write':
    case 'activate':
    case 'transport':
      return 'COBWEB_ALLOW_WRITES';
    default:
      return '(none)';
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Is a call refused by COBWEB_DENY_ACTIONS? Entries: `tool`, `tool.action`, `tool.action.TYPE`,
 * each part may use `*`. A shorter entry covers everything below it.
 */
export function isDenied(denyList: readonly string[], tool: string, action?: string, type?: string): boolean {
  const target = [tool, action, type];
  return denyList.some((entry) => {
    const parts = entry.split('.').filter(Boolean);
    if (parts.length === 0 || parts.length > 3) return false;
    return parts.every((part, i) => {
      const value = target[i];
      // A tool without an action parameter is matched by `*` in the action position.
      if (value === undefined) return part === '*';
      return globToRegExp(part).test(value);
    });
  });
}

/** Matches a name against a list of patterns with `*` (for packages and InfoAreas). */
export function matchesAny(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(name));
}
