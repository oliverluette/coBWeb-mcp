/**
 * The tool catalog: name, description, input schema and risk of every coBWeb tool.
 *
 * Schemas are plain JSON Schema written by hand, because their size is part of the contract
 * and the same schema validates arguments at run time
 * (src/format/validate.ts), so there is exactly one definition per tool. Enums of object types
 * and actions are built from the configuration: a type or action the server does not offer is
 * not in the schema either.
 */
import { BW_TYPES, type BwType } from './types.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface SchemaContext {
  /** Object types this tool may address under the current configuration. */
  types: BwType[];
  /** Actions of this tool enabled under the current configuration, in catalog order. */
  actions: string[];
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string | ((ctx: SchemaContext) => string);
  /** Parameter that selects the action, for tools with several actions. */
  actionParam?: 'action' | 'what';
  /** All actions of the tool, in schema order. Empty for single-purpose tools. */
  actions: string[];
  /** Object types the tool can address at most. */
  types: readonly BwType[];
  /** true: the tool can destroy or overwrite; or the list of actions that can. */
  destructive: boolean | string[];
  idempotent: boolean;
  schema: (ctx: SchemaContext) => JsonObject;
}

const ALL: readonly BwType[] = BW_TYPES;
const CONTEXT_TYPES: readonly BwType[] = ['IOBJ', 'ADSO', 'HCPR', 'TRCS', 'TRFN', 'DTPA', 'RSDS', 'RSPC', 'QUERY', 'VARIABLE', 'CKF', 'RKF', 'ALVL'];
const WRITE_TYPES: readonly BwType[] = ['AREA', 'IOBJ', 'ADSO', 'HCPR', 'TRCS', 'TRFN', 'DTPA', 'RSDS', 'RSPC', 'QUERY', 'VARIABLE', 'CKF', 'RKF', 'STRUCTURE', 'ALVL', 'FILTER', 'PLSE', 'PLSQ', 'HIER', 'DEST'];
const ACTIVATE_TYPES: readonly BwType[] = ['IOBJ', 'ADSO', 'HCPR', 'TRCS', 'TRFN', 'DTPA', 'RSDS', 'RSPC', 'ALVL'];

const typeEnum = (ctx: SchemaContext): JsonObject => ({ type: 'string', enum: [...ctx.types] });

/** What each code stands for: small models take RSPC for a CompositeProvider without it. */
const TYPE_WORDS: Record<string, string> = {
  AREA: 'InfoArea',
  IOBJ: 'InfoObject (characteristic, key figure)',
  ADSO: 'DataStore object',
  HCPR: 'CompositeProvider',
  TRCS: 'InfoSource',
  TRFN: 'transformation',
  DTPA: 'data transfer process (DTP)',
  RSDS: 'DataSource',
  LSYS: 'source system',
  RSPC: 'process chain',
  QUERY: 'query',
  VARIABLE: 'query variable',
  CKF: 'calculated key figure',
  RKF: 'restricted key figure',
  STRUCTURE: 'query structure',
  ALVL: 'aggregation level',
  FILTER: 'planning filter',
  PLSE: 'planning function',
  PLSQ: 'planning sequence',
  HIER: 'hierarchy',
  DEST: 'Open Hub destination',
  ROLE: 'role',
};

/** The type enum with the meaning of every offered code, where the model chooses a type. */
const typeChoice = (ctx: SchemaContext): JsonObject => ({
  ...typeEnum(ctx),
  description: ctx.types.map((t) => `${t} ${TYPE_WORDS[t] ?? t}`).join(', '),
});
const actionEnum = (ctx: SchemaContext, extra: JsonObject = {}): JsonObject => ({ type: 'string', enum: [...ctx.actions], ...extra });
const RSDS_ONLY: JsonObject = { type: 'string', description: 'Only for RSDS.' };

export const CATALOG: readonly ToolSpec[] = [
  {
    name: 'bw_search',
    title: 'Search BW objects',
    description:
      'Find BW objects by technical name or description, or list the contents of an InfoArea. Use it when you do not know the exact name or want to check that a name is free. Wildcard * is allowed. Returns type, name, description and active state, at most `limit` hits plus a total count.',
    actions: [],
    types: ALL,
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or text pattern, e.g. ZSALES* or *revenue*. Omit to list info_area.' },
        types: { type: 'array', items: typeChoice(ctx), description: 'Restrict to these object types.' },
        info_area: { type: 'string', description: 'List the objects in this InfoArea (one level).' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        source_system: { type: 'string', description: 'Only DataSources of this source system.' },
      },
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_read',
    title: 'Read a BW object',
    description:
      'Read the definition of one BW object. detail="summary" (default) returns a compact, model-friendly overview (fields, keys, settings, status); "full" adds every property; "raw" returns the backend XML/JSON and should only be used for debugging. Use part to read only one section of a large object, e.g. fields, keys, rules, steps, layout.',
    actions: [],
    types: ALL,
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        type: typeEnum(ctx),
        name: { type: 'string', description: 'Technical name.' },
        source_system: RSDS_ONLY,
        detail: { type: 'string', enum: ['summary', 'full', 'raw'], default: 'summary' },
        part: { type: 'string', description: 'Optional section filter, e.g. fields, keys, rules, routines, steps, layout, filter.' },
      },
      required: ['type', 'name'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_context',
    title: 'Data flow and where-used',
    description:
      'Show how a BW object is connected: relation="dataflow" lists sources and targets with the transformations and DTPs between them; "where_used" lists objects that reference it (impact before a change). Use it instead of reading many objects one by one. depth controls how many hops are followed.',
    actions: [],
    types: CONTEXT_TYPES,
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        type: typeEnum(ctx),
        name: { type: 'string' },
        source_system: RSDS_ONLY,
        relation: { type: 'string', enum: ['dataflow', 'where_used'], default: 'dataflow' },
        direction: { type: 'string', enum: ['up', 'down', 'both'], default: 'both' },
        depth: { type: 'integer', default: 1, minimum: 1, maximum: 5 },
      },
      required: ['type', 'name'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_describe',
    title: 'Spec format for bw_write',
    description:
      'Return the spec format bw_write expects for one object type and action: allowed fields, data types, defaults, rules and a minimal example. Call it once per type before the first bw_write of that type; the result does not change during a session.',
    actions: [],
    types: WRITE_TYPES,
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        type: typeChoice(ctx),
        action: { type: 'string', enum: ['create', 'update'], default: 'create' },
      },
      required: ['type'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_write',
    title: 'Create, change or delete BW objects',
    description:
      'Create, update or delete BW objects and activate them in the same call. Pass one object or several in `objects`; the server sorts them by dependency (InfoArea, InfoObjects, providers, transformations, DTPs), locks, saves, activates and unlocks. spec is type-specific: get its format from bw_describe. update merges the given spec into the object; delete needs no spec. Returns one result line per object (created, changed, unchanged, deleted, failed, skipped) with the reason and a hint.',
    actionParam: undefined,
    actions: ['create', 'update', 'delete'],
    types: WRITE_TYPES,
    destructive: true,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            properties: {
              action: actionEnum(ctx),
              type: typeChoice(ctx),
              name: { type: 'string', description: 'Omit when creating a TRFN or DTPA: BW generates it.' },
              source_system: RSDS_ONLY,
              spec: { type: 'object', description: 'Type-specific definition, see bw_describe.' },
            },
            required: ['action', 'type'],
            additionalProperties: false,
          },
        },
        package: { type: 'string', default: '$TMP' },
        transport: { type: 'string', description: 'Transport request; required outside $TMP on systems with transport recording.' },
        activate: { type: 'boolean', default: true },
        validate_only: { type: 'boolean', default: false, description: 'Check specs, names, limits and dependencies against BW without writing.' },
      },
      required: ['objects'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_activate',
    title: 'Check or activate BW objects',
    description:
      'Check or activate existing inactive BW objects, e.g. DTPs that a change deactivated or objects saved with activate=false. check_only=true runs the consistency check without activating. Returns the result per object and the objects the activation deactivated.',
    actions: [],
    types: ACTIVATE_TYPES,
    destructive: true,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { type: typeEnum(ctx), name: { type: 'string' }, source_system: { type: 'string' } },
            required: ['type', 'name'],
            additionalProperties: false,
          },
        },
        check_only: { type: 'boolean', default: false },
        transport: { type: 'string' },
      },
      required: ['objects'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_data',
    title: 'Read data',
    description:
      'Read data: action="query" runs a query or reads a provider (ADSO, HCPR) directly, with rows, columns, filter and variables by name; "preview" shows DataSource rows; "values" lists the values of a characteristic. Results say whether more rows follow. Business data leaves the system; only where the administrator allows it.',
    actionParam: 'action',
    actions: ['query', 'preview', 'values'],
    types: [],
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        action: actionEnum(ctx),
        source: { type: 'string', description: 'Query or provider (query), DataSource (preview), characteristic (values).' },
        source_system: { type: 'string', description: 'preview: source system of the DataSource.' },
        rows: { type: 'array', items: { type: 'string' } },
        columns: { type: 'array', items: { type: 'string' }, description: 'Characteristics or structures; others go to the free area.' },
        filter: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              values: { type: 'array', items: { type: 'string' } },
              selections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { op: { type: 'string', enum: ['eq', 'ne', 'between', 'gt', 'ge', 'lt', 'le'] }, low: { type: 'string' }, high: { type: 'string' }, exclude: { type: 'boolean' } },
                  required: ['low'],
                  additionalProperties: false,
                },
              },
              nodes: { type: 'array', items: { type: 'string' }, description: 'Text nodes of the display hierarchy of the query.' },
              exclude: { type: 'boolean' },
              internal: { type: 'boolean', description: 'Values are internal keys.' },
            },
            required: ['field'],
            additionalProperties: false,
          },
        },
        variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'NAME -> "A", "A..B" or "A,B".' },
        search: { type: 'string', description: 'values: pattern, default *.' },
        provider: { type: 'string', description: 'values: only values posted in this provider.' },
        offset: { type: 'integer', default: 0, minimum: 0 },
        max_rows: { type: 'integer', default: 100, minimum: 1, maximum: 5000 },
        with_statistics: { type: 'boolean', description: 'query: runtime and HANA statistics of this call.' },
        collapse: { type: 'array', items: { type: 'string' }, description: 'query: hierarchy nodes to collapse in the result (key or text).' },
        expand: { type: 'array', items: { type: 'string' }, description: 'query: collapsed hierarchy nodes to expand.' },
      },
      required: ['action', 'source'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_monitor',
    title: 'Load and process chain monitor',
    description:
      'Watch loads, chains and queries: chain_status (last run of every chain), chain_runs (runs of a chain), chain_run (steps and messages of one run: name, id), requests (load requests of a provider), request (one request: id), remodeling (requests of a provider; id = rule for details), query_stats (executions of a query or provider). Read-only; act with bw_run.',
    actionParam: 'what',
    actions: ['chain_status', 'chain_runs', 'chain_run', 'requests', 'request', 'remodeling', 'query_stats'],
    types: [],
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        what: actionEnum(ctx),
        name: { type: 'string', description: 'Chain, provider or query.' },
        id: { type: 'string', description: 'Run log id, request TSN, remodeling rule or statistics step.' },
        request: { type: 'string', description: 'remodeling: request number.' },
        status: { type: 'string', description: 'Status codes as the answers show them.' },
        since: { type: 'string', description: 'ISO date or timestamp.' },
        until: { type: 'string' },
        storage: { type: 'string', description: 'requests/request: storage, e.g. AQ.' },
        target_type: { type: 'string', description: 'requests: ADSO (default) or IOBJ.' },
        detail: { type: 'string', enum: ['summary', 'full', 'raw'], default: 'summary' },
        limit: { type: 'integer', minimum: 0, maximum: 200 },
      },
      required: ['what'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_run',
    title: 'Run loads and runtime actions',
    description:
      'Runtime actions that change data: run_dtp, start_chain (wait_seconds up to 600), activate_request and delete_request (id = request TSN, name = target), run_remodeling (name = provider, id = rule, mode), push_data (records into a write-interface ADSO). Check the result with bw_monitor. Only where the administrator allows runtime actions.',
    actionParam: 'action',
    actions: ['run_dtp', 'start_chain', 'activate_request', 'delete_request', 'run_remodeling', 'push_data'],
    types: [],
    destructive: true,
    idempotent: false,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        action: actionEnum(ctx),
        name: { type: 'string', description: 'DTP, chain, ADSO or provider.' },
        id: { type: 'string', description: 'Request TSN or remodeling rule.' },
        storage: { type: 'string', description: 'Request storage, default AQ.' },
        target_type: { type: 'string', description: 'delete_request: ADSO (default) or IOBJ.' },
        all_requests: { type: 'boolean', description: 'delete_request: every request of the target.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600 },
        mode: { type: 'string', description: 'run_remodeling: execute|restart|reset|reset_step; push_data: one_step|messaging.' },
        request: { type: 'string', description: 'run_remodeling: request number.' },
        start: { type: 'string', description: 'run_remodeling: start, default immediate.' },
        records: { type: 'array', items: { type: 'object' }, description: 'push_data: [{FIELD: value}].' },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_transport',
    title: 'Transports and packages',
    description: (ctx) =>
      ctx.actions.length === 1
        ? 'List the changeable transport requests (own, modifiable by default). Use it before bw_write when an object lives outside $TMP.'
        : 'Transports: list the changeable requests, create_task in a request for a user, assign objects to a package (and transport), move objects to another InfoArea. Use list before bw_write when an object lives outside $TMP.',
    actionParam: 'action',
    actions: ['list', 'create_task', 'assign', 'move'],
    types: ALL,
    destructive: false,
    idempotent: true,
    schema: (ctx) => ({
      type: 'object',
      properties: {
        action: actionEnum(ctx),
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: { type: typeEnum(ctx), name: { type: 'string' }, source_system: { type: 'string' } },
            required: ['type', 'name'],
            additionalProperties: false,
          },
        },
        transport: { type: 'string' },
        package: { type: 'string' },
        info_area: { type: 'string', description: 'move: target InfoArea.' },
        user: { type: 'string', description: 'create_task: task owner.' },
        all_users: { type: 'boolean', description: 'list: requests of every user.' },
        include_released: { type: 'boolean' },
        with_objects: { type: 'boolean', description: 'list: the objects of each task.' },
      },
      required: ['action'],
      additionalProperties: false,
    }),
  },
  {
    name: 'bw_system',
    title: 'System profile and maintenance',
    description: (ctx) =>
      ctx.actions.includes('unlock')
        ? 'System information and maintenance: profile shows release, platform (BW/4HANA or classic), enabled object types, the active safety settings and naming rules; unlock releases a lock this server still holds after an aborted change. Call profile only when a write fails for a system reason, not as a first step.'
        : 'System information: release, platform (BW/4HANA or classic), enabled object types and the active safety settings. Call it only when a call fails for a system reason, not as a first step.',
    actionParam: 'action',
    actions: ['profile', 'unlock'],
    types: ALL,
    destructive: ['unlock'],
    idempotent: true,
    schema: (ctx) => {
      const props: JsonObject = { action: actionEnum(ctx, { default: 'profile' }) };
      if (ctx.actions.includes('unlock')) {
        props.type = { ...typeEnum(ctx), description: 'Only for unlock.' };
        props.name = { type: 'string' };
      }
      return { type: 'object', properties: props, additionalProperties: false };
    },
  },
];

export function catalogEntry(name: string): ToolSpec | undefined {
  return CATALOG.find((t) => t.name === name);
}
