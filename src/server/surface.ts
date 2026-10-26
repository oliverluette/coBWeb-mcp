/**
 * The tool surface: which tools, actions and object types this server offers, and the
 * definitions it sends in `tools/list`.
 *
 * Computed once at start from the configuration (profile, COBWEB_TOOLS, COBWEB_TYPES, flags,
 * COBWEB_DENY_ACTIONS) and the set of implemented tools. The list does not change while the
 * server runs, and its order is the catalog order (deterministic, cache friendly).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CATALOG, type JsonObject, type SchemaContext, type ToolSpec } from '../catalog/tools.js';
import type { BwType } from '../catalog/types.js';
import type { Config } from '../config.js';
import { classEnabled, isDenied, opClassOf, READ_ONLY_CLASSES } from '../policy/policy.js';

export interface OfferedTool {
  spec: ToolSpec;
  ctx: SchemaContext;
  schema: JsonObject;
  definition: Tool;
}

/** Tools Claude Code should load up front even with tool search on. */
const ALWAYS_LOAD = new Set(['bw_search', 'bw_read', 'bw_write']);

function enabledActions(spec: ToolSpec, config: Config): string[] | null {
  if (spec.actions.length === 0) {
    const ok = classEnabled(opClassOf(spec.name), config) && !isDenied(config.denyActions, spec.name);
    return ok ? [] : null;
  }
  const actions = spec.actions.filter(
    (a) => classEnabled(opClassOf(spec.name, a), config) && !isDenied(config.denyActions, spec.name, a),
  );
  return actions.length > 0 ? actions : null;
}

function annotations(spec: ToolSpec, actions: string[]) {
  const classes = actions.length > 0 ? actions.map((a) => opClassOf(spec.name, a)) : [opClassOf(spec.name)];
  const readOnly = classes.every((c) => READ_ONLY_CLASSES.has(c));
  const destructive =
    spec.destructive === true || (Array.isArray(spec.destructive) && spec.destructive.some((a) => actions.includes(a)));
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : destructive,
    idempotentHint: spec.idempotent,
    openWorldHint: false,
  };
}

export interface SurfaceOptions {
  /** Names of implemented tools, or 'all' to describe the whole catalog (budget measurement). */
  implemented: ReadonlySet<string> | 'all';
  /** Object types per tool that this version supports; narrows the type enums. */
  types?: Readonly<Record<string, readonly BwType[]>>;
}

export function buildSurface(config: Config, opts: SurfaceOptions): OfferedTool[] {
  const offered: OfferedTool[] = [];
  for (const spec of CATALOG) {
    if (!config.tools.includes(spec.name)) continue;
    if (opts.implemented !== 'all' && !opts.implemented.has(spec.name)) continue;
    const actions = enabledActions(spec, config);
    if (actions === null) continue;
    const supported = opts.types?.[spec.name];
    const types = spec.types.filter((t) => config.types.includes(t) && (!supported || supported.includes(t)));
    if (spec.types.length > 0 && types.length === 0) continue;
    const ctx: SchemaContext = { types, actions };
    const schema = spec.schema(ctx);
    const description = typeof spec.description === 'function' ? spec.description(ctx) : spec.description;
    const definition: Tool = {
      name: spec.name,
      title: spec.title,
      description,
      inputSchema: schema as Tool['inputSchema'],
      annotations: annotations(spec, actions),
    };
    if (ALWAYS_LOAD.has(spec.name)) definition._meta = { 'anthropic/alwaysLoad': true };
    offered.push({ spec, ctx, schema, definition });
  }
  return offered;
}
