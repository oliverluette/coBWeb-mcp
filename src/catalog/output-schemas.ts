/**
 * Output schemas of the structured results (COBWEB_STRUCTURED=true): exactly one definition
 * per tool. Every answer is an envelope {schema, data}; `schema` is a const in each variant, so
 * exactly one variant matches. Data schemas name the required fields and leave room for new
 * optional ones, which do not change the version.
 */
import type { JsonObject } from './tools.js';
import { ERROR, UNSTRUCTURED } from '../format/structured.js';

const str = { type: 'string' };
const strOrNull = { type: ['string', 'null'] };
const intOrNull = { type: ['integer', 'null'] };
const strings = { type: 'array', items: str };
const status = { type: ['string', 'null'] };

const obj = (required: string[], properties: JsonObject): JsonObject => ({ type: 'object', required, properties });

const REF = obj(['ref', 'type', 'name'], { ref: str, type: str, name: str, source_system: str, part: str, sub_type: str });
const HEAD_FIELDS = ['ref', 'type', 'name', 'status', 'description'];
const head = (extra: JsonObject = {}): JsonObject => ({ ref: str, type: str, name: str, source_system: str, part: str, sub_type: str, status, status_raw: str, description: str, ...extra });

const variant = (schema: string, data: JsonObject): JsonObject => ({
  type: 'object',
  required: ['schema', 'data'],
  properties: { schema: { const: schema }, data },
  additionalProperties: false,
});

const UNSTRUCTURED_V = variant(UNSTRUCTURED, { type: 'null' });
const ERROR_V = variant(ERROR, obj(['kind', 'message', 'hint'], { kind: str, message: str, hint: strOrNull }));

const NODE = obj([...HEAD_FIELDS, 'sources', 'targets'], head({ sources: strings, targets: strings }));

export const DATAFLOW = variant(
  'cobweb.dataflow/1',
  obj(['root', 'direction', 'depth', 'objects', 'flows', 'unresolved'], {
    root: REF,
    direction: { type: 'string', enum: ['up', 'down', 'both'] },
    depth: { type: 'integer' },
    objects: { type: 'array', items: NODE },
    flows: { type: 'array', items: NODE },
    unresolved: { type: 'array', items: obj(['from', 'node_id', 'side'], { from: str, node_id: { type: 'integer' }, side: { type: 'string', enum: ['source', 'target'] } }) },
  }),
);

export const WHERE_USED = variant(
  'cobweb.where_used/1',
  obj(['root', 'hits'], {
    root: REF,
    hits: {
      type: 'array',
      items: obj([...HEAD_FIELDS, 'side', 'flow'], head({
        side: { type: 'string', enum: ['up', 'down', 'other'] },
        flow: {
          anyOf: [
            { type: 'null' },
            obj(['source', 'source_part', 'target', 'target_part'], { source: str, source_part: strOrNull, target: str, target_part: strOrNull }),
          ],
        },
      })),
    },
  }),
);

export const SEARCH = variant(
  'cobweb.search/1',
  obj(['query', 'info_area', 'types', 'total', 'returned', 'truncated', 'hits', 'notes'], {
    query: strOrNull,
    info_area: strOrNull,
    source_system: strOrNull,
    types: strings,
    total: { type: 'integer' },
    returned: { type: 'integer' },
    truncated: { type: 'boolean' },
    hits: { type: 'array', items: obj(HEAD_FIELDS, head()) },
    notes: strings,
  }),
);

export const SYSTEM = variant(
  'cobweb.system/1',
  obj(['cobweb_version', 'platform', 'release', 'logical_system', 'database', 'structured', 'writes', 'data_access', 'runtime_actions'], {
    cobweb_version: str,
    platform: { type: 'string', enum: ['bw4', 'classic'] },
    release: strOrNull,
    logical_system: strOrNull,
    database: strOrNull,
    structured: { type: 'boolean' },
    writes: { type: 'boolean' },
    data_access: { type: 'boolean' },
    runtime_actions: { type: 'boolean' },
    tools: strings,
  }),
);

const LOCATION = { info_area: strOrNull, package: strOrNull };

export const OBJECT_HEAD = variant('cobweb.object_head/1', obj([...HEAD_FIELDS, 'info_area', 'package'], head({ ...LOCATION, keys: strings })));

export const HCPR = variant(
  'cobweb.hcpr/1',
  obj([...HEAD_FIELDS, 'composition', 'info_area', 'package', 'inputs', 'fields', 'joins'], head({
    ...LOCATION,
    composition: { type: 'string', enum: ['union', 'join', 'unknown'] },
    inputs: {
      type: 'array',
      items: obj(['alias', 'provider', 'provider_type', 'provider_name', 'mappings'], {
        alias: str,
        provider: str,
        provider_type: strOrNull,
        provider_name: str,
        mappings: { type: 'integer' },
      }),
    },
    fields: { type: 'array', items: obj(['name', 'key_figure'], { name: str, key_figure: { type: 'boolean' } }) },
    joins: { type: 'array' },
  })),
);

const ROUTINE = { anyOf: [{ type: 'null' }, obj(['class', 'method'], { class: strOrNull, method: strOrNull })] };
const END = obj(['ref', 'type', 'name', 'part'], { ref: str, type: str, name: str, source_system: str, part: strOrNull });

export const TRFN = variant(
  'cobweb.trfn/1',
  obj([...HEAD_FIELDS, 'runtime', 'source', 'target', 'routines', 'rules', 'source_fields', 'target_fields'], head({
    package: strOrNull,
    runtime: { type: ['string', 'null'], enum: ['abap', 'hana', null] },
    source: END,
    target: END,
    routines: obj(['start', 'end', 'expert'], { start: ROUTINE, end: ROUTINE, expert: ROUTINE }),
    rules: { type: 'array', items: obj(['kind', 'sources', 'targets'], { kind: str, sources: strings, targets: strings, detail: strOrNull }) },
    source_fields: strings,
    target_fields: strings,
  })),
);

export const DTPA = variant(
  'cobweb.dtpa/1',
  obj([...HEAD_FIELDS, 'mode', 'mode_raw', 'package_size', 'source', 'target', 'transformation', 'filter', 'selectable_without_value', 'semantic_group', 'global_routine_lines'], head({
    mode: { type: 'string', enum: ['full', 'delta', 'other'] },
    mode_raw: str,
    package_size: intOrNull,
    source: str,
    target: str,
    transformation: strOrNull,
    filter: {
      type: 'array',
      items: obj(['field', 'has_routine', 'routine_lines', 'selections'], {
        field: str,
        has_routine: { type: 'boolean' },
        routine_lines: { type: 'integer' },
        selections: {
          type: 'array',
          items: obj(['operator', 'excluding', 'low', 'high'], { operator: str, excluding: { type: 'boolean' }, low: str, high: strOrNull }),
        },
      }),
    },
    selectable_without_value: strings,
    semantic_group: strings,
    global_routine_lines: { type: 'integer' },
  })),
);

const tool = (...variants: JsonObject[]): JsonObject => ({ type: 'object', oneOf: [...variants, UNSTRUCTURED_V, ERROR_V] });

/** Output schema per tool; tools not listed here have none and answer with text only. */
export const OUTPUT_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  bw_search: tool(SEARCH),
  bw_read: tool(HCPR, TRFN, DTPA, OBJECT_HEAD),
  bw_context: tool(DATAFLOW, WHERE_USED),
  bw_system: tool(SYSTEM),
};
