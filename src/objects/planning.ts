/**
 * Planning: aggregation levels (ALVL), planning filters (FILTER), planning functions (PLSE) and
 * planning sequences (PLSQ).
 *
 * The documents are read and written by the proven paths in src/legacy/planning*.ts. Their
 * text output is already the compact form a model needs, so it is the summary here.
 */
import type { BwClient } from '../bw/client.js';
import { bwSeg, MEDIA_TYPES } from '../bw/client.js';
import { timeValue } from '../bw/time-values.js';
import type { BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import { bwDelete } from '../legacy/delete.js';
import {
  bwCreateAggregationLevel,
  bwGetAggregationLevel,
  bwGetPlanningFilter,
  bwGetPlanningFunction,
  bwGetPlanningProperties,
  bwGetPlanningSequence,
  bwUpdateAggregationLevelFields,
} from '../legacy/planning.js';
import { bwCreatePlanningFilter, bwUpdatePlanningFilter, type PlanningFilterOperation } from '../legacy/planning_filter_write.js';
import {
  bwCreatePlanningFunction,
  bwUpdatePlanningFunction,
  type ConditionChange,
  type ParameterChange,
  type PlanningFunctionChanges,
} from '../legacy/planning_function_write.js';
import { bwCreatePlanningSequence, bwUpdatePlanningSequence, type SequenceStepInput } from '../legacy/planning_sequence_write.js';
import { isNotFound, xmlDecode, type ObjectAdapter, type ObjectRef, type ReadOptions, type Spec, type WriteAction } from './adapter.js';
import { checkSelections, filterValuesOf, selectionsOf, SELECTION } from './qspec.js';

type Rec = Record<string, unknown>;

/** Package and InfoArea of a planning document; the element names differ by type. */
function locationOf(xml: string): { infoArea?: string; package?: string } {
  const infoArea = xml.match(/<(?:\w+:)?infoArea>([^<]*)<\/(?:\w+:)?infoArea>/)?.[1] || xml.match(/\binfoArea="([^"]+)"/)?.[1];
  const pkg = xml.match(/<adt[Cc]ore:packageRef\b[^>]*\badt[Cc]ore:name="([^"]*)"/)?.[1];
  return { ...(infoArea ? { infoArea: xmlDecode(infoArea) } : {}), ...(pkg ? { package: pkg } : {}) };
}

function ok(text: string, what: string): string {
  if (/^\s*\{/.test(text)) {
    const r = JSON.parse(text) as Rec;
    if (r['success'] === false) throw new ToolError('validation', `${what}: ${legacyRefusal(r)}`);
  }
  return text;
}

/**
 * Runs a create and removes what it left behind when it fails. Several planning objects are
 * saved in two steps (an empty object first, then its settings); BW keeps the first step
 * when the second is refused. A create reaches an adapter only for an object that did not
 * exist before, so the cleanup cannot remove anything older.
 */
async function createClean<T>(client: BwClient, collection: string, name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const removed = await bwDelete(client, collection, name).then(() => true, () => false);
    if (removed && err instanceof ToolError) throw new ToolError(err.kind, `${err.message} (the partly created object was removed)`, err.hint);
    throw err;
  }
}

/**
 * part="planning" of an InfoProvider: characteristic relationships, data slices and the
 * planning settings, without the resource links of the provider section.
 */
export async function planningPart(client: BwClient, provider: string): Promise<string> {
  const text = await bwGetPlanningProperties(client, provider.toUpperCase());
  return text
    .split(/\n(?=── )/)
    .filter((sec) => !/^── Provider ──/.test(sec))
    .map((sec) => sec.trimEnd())
    .join('\n\n')
    .replace(/^Status:\s+unknown\n/m, '');
}

const NAME = /^[A-Z][A-Z0-9_]{2,29}$/i;
const NAME_20 = /^[A-Z][A-Z0-9_]{2,19}$/i;

interface Kind {
  type: BwType;
  label: string;
  collection: string;
  version: 'a' | 'm';
  text: (client: BwClient, name: string) => Promise<string>;
  /** The document's objectStatus means nothing (a planning filter has no activation of its own). */
  noStatus?: boolean;
  /** Shortens the text for the summary view. */
  condense?: (text: string) => string;
}

function reader(k: Kind) {
  const raw = (client: BwClient, name: string) => client.get(`/sap/bw/modeling/${k.collection}/${bwSeg(name)}/${k.version}`, MEDIA_TYPES[k.collection]).then((r) => r.body);
  return {
    type: k.type,
    label: k.label,
    async locate(client: BwClient, name: string) {
      try {
        const xml = await raw(client, name);
        const status = xml.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1];
        return { exists: true, ...locationOf(xml), ...(status && !k.noStatus ? { active: status === 'active' && !/<contentState>REV</.test(xml) } : {}) };
      } catch (err) {
        if (isNotFound(err)) return { exists: false };
        throw err;
      }
    },
    async read(client: BwClient, name: string, { detail }: ReadOptions) {
      if (detail === 'raw') return raw(client, name);
      let text = (await k.text(client, name)).trim().replace(/^Status:\s+unknown\n/m, '');
      if (detail !== 'full' && k.condense) text = k.condense(text);
      return `${k.type} ${name.toUpperCase()}\n${text}`;
    },
  };
}

// ── Aggregation level ─────────────────────────────────────────────────────────

const ALVL_CREATE: JsonObject = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    description: { type: 'string', maxLength: 60 },
    info_area: { type: 'string' },
    fields: { type: 'array', items: { type: 'string' } },
  },
  required: ['provider', 'description', 'info_area'],
  additionalProperties: false,
};
const ALVL_UPDATE: JsonObject = {
  type: 'object',
  properties: { fields: { type: 'array', items: { type: 'string' } }, fields_add: { type: 'array', items: { type: 'string' } }, fields_remove: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
};

/** Fields of an aggregation level as its document lists them (characteristics and key figures). */
function alvlFields(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?element\b[^>]*\bname="([^"]+)"[^>]*\bselected="true"/g)].map((m) => m[1].toUpperCase());
}

/** A field named bare on a CompositeProvider level carries a prefix there ("4ZCP-FIELD"). */
const sameField = (a: string, b: string) => a === b || a.replace(/^.*-/, '') === b.replace(/^.*-/, '');

export const alvlAdapter: ObjectAdapter = {
  ...reader({ type: 'ALVL', label: 'Aggregation level', collection: 'alvl', version: 'm', text: (c, n) => bwGetAggregationLevel(c, n) }),
  activationType: 'alvl',
  describe(action) {
    return action === 'create'
      ? [
          'ALVL create spec (aggregation level on a planning-enabled ADSO or CompositeProvider)',
          '  provider      the InfoProvider                                        (required)',
          '  description   text, max 60                                            (required)',
          '  info_area     InfoArea                                                (required)',
          '  fields        characteristics and key figures to expose; default all. At least',
          '                one key figure; a characteristic left out is aggregated away',
          'The aggregation level is activated in the same call.',
          'Example',
          '  {"action":"create","type":"ALVL","name":"ZCW_AL1","spec":{"provider":"ZPLAN01","description":"Plan level","info_area":"ZPLAN","fields":["ZREGION","0CALMONTH","ZAMOUNT"]}}',
        ].join('\n')
      : ['ALVL update spec', '  fields         complete list; fields_add / fields_remove instead', 'The aggregation level is activated again in the same call.'].join('\n');
  },
  check(action, name, spec) {
    if (action === 'delete') return [];
    const errors = validateArgs(action === 'create' ? ALVL_CREATE : ALVL_UPDATE, (spec ?? {}) as JsonObject).errors;
    if (action === 'create' && !NAME.test(name)) errors.push('name: 3 to 30 characters, letters, digits and _');
    const s = (spec ?? {}) as Rec;
    if (s['fields'] !== undefined && (s['fields_add'] !== undefined || s['fields_remove'] !== undefined)) errors.push('fields: give either the complete list or fields_add / fields_remove');
    return errors;
  },
  dependsOn() {
    return [];
  },
  targetInfoArea: (_n, spec) => (typeof (spec as Rec)['info_area'] === 'string' ? String((spec as Rec)['info_area']).toUpperCase() : undefined),
  boundary: (spec) => (typeof (spec as Rec)['provider'] === 'string' ? [{ type: 'PROVIDER' as BwType, name: String((spec as Rec)['provider']).toUpperCase() }] : []),
  async create(name, spec, ctx) {
    return createClean(ctx.client, 'alvl', name, async () => {
      const s = spec as Rec;
      ok(
        await bwCreateAggregationLevel(ctx.client, name, {
          label: String(s['description']),
          infoArea: String(s['info_area']).toUpperCase(),
          infoProvider: String(s['provider']).toUpperCase(),
          package: ctx.package,
          ...(Array.isArray(s['fields']) ? { fields: (s['fields'] as string[]).map((f) => f.toUpperCase()) } : {}),
          ...(ctx.transport ? { transport: ctx.transport } : {}),
        }),
        `Aggregation level ${name}`,
      );
      return { status: 'created', activation: { lockHandle: '' }, notes: [`on ${String(s['provider']).toUpperCase()}`] };
    });
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const xml = (await ctx.client.get(`/sap/bw/modeling/alvl/${bwSeg(name)}/m`, MEDIA_TYPES['alvl'])).body;
    const now = alvlFields(xml);
    const up = (l: unknown) => ((l as string[] | undefined) ?? []).map((f) => f.toUpperCase());
    let add = up(s['fields_add']).filter((f) => !now.some((n) => sameField(n, f)));
    let remove = up(s['fields_remove']).filter((f) => now.some((n) => sameField(n, f)));
    if (Array.isArray(s['fields'])) {
      const want = up(s['fields']);
      add = want.filter((f) => !now.some((n) => sameField(n, f)));
      remove = now.filter((n) => !want.some((f) => sameField(n, f)));
    }
    const notes: string[] = [];
    // Additions first, so a level never drops below one characteristic and one key figure.
    if (add.length) {
      ok(await bwUpdateAggregationLevelFields(ctx.client, name, 'add_fields', add, { transport: ctx.transport }), `Aggregation level ${name}`);
      notes.push(`added ${add.join(', ')}`);
    }
    if (remove.length) {
      ok(await bwUpdateAggregationLevelFields(ctx.client, name, 'remove_fields', remove, { transport: ctx.transport }), `Aggregation level ${name}`);
      notes.push(`removed ${remove.join(', ')}`);
    }
    return notes.length ? { status: 'changed', activation: { lockHandle: '' }, notes } : { status: 'unchanged' };
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'alvl', name);
    return { status: 'deleted' };
  },
};

// ── Planning filter ───────────────────────────────────────────────────────────

function filterOperations(list: unknown): PlanningFilterOperation[] {
  return ((Array.isArray(list) ? list : []) as Rec[]).map((e) => {
    const field = String(e['field']).toUpperCase();
    if (typeof e['variable'] === 'string') return { action: 'set_variable', infoobject: field, variable_name: e['variable'].toUpperCase() };
    const values = filterValuesOf(e);
    return values.length ? { action: 'set_values', infoobject: field, values } : { action: 'remove', infoobject: field };
  });
}

const FILTER_SPEC: JsonObject = {
  type: 'object',
  properties: {
    level: { type: 'string' },
    description: { type: 'string', maxLength: 60 },
    restrictions: { type: 'array', items: SELECTION },
  },
  additionalProperties: false,
};

export const filterAdapter: ObjectAdapter = {
  ...reader({ type: 'FILTER' as BwType, label: 'Planning filter', collection: 'filter', version: 'a', noStatus: true, text: (c, n) => bwGetPlanningFilter(c, n) }),
  describe(action) {
    return [
      `FILTER ${action} spec (planning filter on an aggregation level)`,
      ...(action === 'create' ? ['  level          aggregation level                                      (required)'] : []),
      `  description    text, max 60${action === 'create' ? '                                           (required)' : ''}`,
      '  restrictions   per characteristic: {field, values, exclude} | {field, selections: [{op',
      `                 eq|ne|between, low, high, exclude}]} | {field, variable}${action === 'update' ? '; only the named characteristics change, values [] removes one' : ''}`,
      'Time characteristics take 202601 or 01.2026. Saved active.',
      'Example',
      '  {"action":"create","type":"FILTER","name":"ZCW_F1","spec":{"level":"ZCW_AL1","description":"Region EU 2026","restrictions":[{"field":"ZREGION","values":["EU"]},{"field":"0CALYEAR","values":["2026"]}]}}',
    ].join('\n');
  },
  check(action, name, spec) {
    if (action === 'delete') return [];
    const s = (spec ?? {}) as Rec;
    const errors = validateArgs(FILTER_SPEC, s as JsonObject).errors.filter((m) => !/restrictions/.test(m));
    if (action === 'create') {
      if (!NAME.test(name)) errors.push('name: 3 to 30 characters, letters, digits and _');
      if (typeof s['level'] !== 'string') errors.push('level: required (the aggregation level)');
      if (typeof s['description'] !== 'string') errors.push('description: required');
    } else if (s['level'] !== undefined) errors.push('level: a filter cannot move to another aggregation level');
    checkSelections(s['restrictions'], 'restrictions', ['eq', 'between'], errors, true);
    return errors;
  },
  dependsOn(action, _n, spec) {
    const s = (spec ?? {}) as Rec;
    const refs: ObjectRef[] = action === 'create' && typeof s['level'] === 'string' ? [{ type: 'ALVL', name: s['level'].toUpperCase() }] : [];
    for (const r of (Array.isArray(s['restrictions']) ? s['restrictions'] : []) as Rec[]) if (typeof r['variable'] === 'string') refs.push({ type: 'VARIABLE', name: r['variable'].toUpperCase() });
    return refs;
  },
  targetInfoArea: () => undefined,
  boundary: (spec) => (typeof (spec as Rec)['level'] === 'string' ? [{ type: 'ALVL', name: String((spec as Rec)['level']).toUpperCase() }] : []),
  async create(name, spec, ctx) {
    return createClean(ctx.client, 'filter', name, async () => {
      const s = spec as Rec;
      ok(
        await bwCreatePlanningFilter(ctx.client, {
          filter_name: name,
          aggregation_level: String(s['level']).toUpperCase(),
          description: String(s['description']),
          operations: filterOperations(s['restrictions']),
          package: ctx.package,
          ...(ctx.transport ? { transport: ctx.transport } : {}),
        }),
        `Planning filter ${name}`,
      );
      return { status: 'created', activated: true, notes: [`on ${String(s['level']).toUpperCase()}`] };
    });
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const operations = filterOperations(s['restrictions']);
    if (!operations.length && typeof s['description'] !== 'string') return { status: 'unchanged' };
    ok(
      await bwUpdatePlanningFilter(ctx.client, {
        filter_name: name,
        ...(operations.length ? { operations } : {}),
        ...(typeof s['description'] === 'string' ? { description: s['description'] } : {}),
        ...(ctx.transport ? { transport: ctx.transport } : {}),
      }),
      `Planning filter ${name}`,
    );
    return { status: 'changed', activated: true, notes: [...(operations.length ? [`restrictions ${operations.map((o) => o.infoobject).join(', ')}`] : []), ...(typeof s['description'] === 'string' ? ['description'] : [])] };
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'filter', name);
    return { status: 'deleted' };
  },
};

// ── Planning function ─────────────────────────────────────────────────────────

const USAGE: Record<string, 'FIELDS_TO_BE_CHANGED' | 'FIELD_FOR_CONDITIONS' | 'NONE'> = { changed: 'FIELDS_TO_BE_CHANGED', condition: 'FIELD_FOR_CONDITIONS', none: 'NONE' };
const COND_OP: Record<string, string> = { eq: 'Equal', between: 'Between', gt: 'Greater', ge: 'GreaterEqual', lt: 'Less', le: 'LessEqual' };

/** A selection-format entry as the constraints of a condition or a data selection. */
function constraintsOf(e: Rec): ConditionChange {
  const field = String(e['field']).toUpperCase();
  if (typeof e['variable'] === 'string') return { characteristic: field, constraints: [{ variable: e['variable'].toUpperCase() }] };
  // The function document takes values in the display form (a month as 01.2026).
  const shown = (v: string) => timeValue(field, v)?.desc ?? v;
  return {
    characteristic: field,
    constraints: selectionsOf(e).map((x) => ({
      operator: x.op === 'eq' && x.exclude && e['selections'] ? 'NotEqual' : COND_OP[x.op] ?? 'Equal',
      value: shown(x.low),
      ...(x.high !== undefined ? { to_value: shown(x.high) } : {}),
      ...(x.exclude && !(x.op === 'eq' && e['selections']) ? { exclude: true } : {}),
    })),
  };
}

const PARAMETER: JsonObject = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    value: { type: 'string' },
    variable: { type: 'string' },
    row: { type: 'integer', minimum: 1 },
    key_figures: { type: 'array', items: { type: 'string' } },
    selection: { type: 'array', items: SELECTION },
  },
  required: ['name'],
  additionalProperties: false,
};

const PLSE_PROPS: Record<string, JsonObject> = {
  description: { type: 'string', maxLength: 60 },
  characteristics: { type: 'object', additionalProperties: { type: 'string', enum: Object.keys(USAGE) } },
  conditions: { type: 'array', items: SELECTION },
  parameters: { type: 'array', items: PARAMETER },
  fox: { type: 'string' },
  rule: { type: 'integer', minimum: 1 },
};

function functionChanges(s: Rec): PlanningFunctionChanges {
  const params: ParameterChange[] = ((s['parameters'] as Rec[] | undefined) ?? []).map((p) => ({
    name: String(p['name']).toUpperCase(),
    ...(typeof p['value'] === 'string' ? { value: p['value'] } : {}),
    ...(typeof p['variable'] === 'string' ? { variable: p['variable'].toUpperCase() } : {}),
    ...(typeof p['row'] === 'number' ? { row: p['row'] } : {}),
    ...(Array.isArray(p['key_figures']) ? { key_figures: (p['key_figures'] as string[]).map((k) => k.toUpperCase()) } : {}),
    ...(Array.isArray(p['selection']) ? { selection: (p['selection'] as Rec[]).map(constraintsOf) } : {}),
  }));
  // The FOX code of a formula function is its FLINE parameter.
  if (typeof s['fox'] === 'string') params.push({ name: 'FLINE', value: s['fox'] });
  const usage = (s['characteristics'] ?? {}) as Record<string, string>;
  return {
    ...(typeof s['description'] === 'string' ? { description: s['description'] } : {}),
    ...(Object.keys(usage).length ? { charUsage: Object.entries(usage).map(([c, u]) => ({ characteristic: c.toUpperCase(), usage: USAGE[u] })) } : {}),
    ...(Array.isArray(s['conditions']) ? { conditions: (s['conditions'] as Rec[]).map((c) => (Array.isArray(c['values']) && !(c['values'] as unknown[]).length ? { characteristic: String(c['field']).toUpperCase(), constraints: [] } : constraintsOf(c))) } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(typeof s['rule'] === 'number' ? { rule: s['rule'] } : {}),
  };
}

/**
 * Summary of a planning function: the formula as a FOX block instead of its parameter rows,
 * and without the function type's documentation and parameter catalogue (detail="full").
 */
export function condensePlse(text: string): string {
  const sections = text.split(/\n(?=── )/);
  const out: string[] = [];
  let fox: string[] | undefined;
  let dropped = false;
  for (const sec of sections) {
    if (/^── (Documentation|Function Type)\b/.test(sec)) {
      dropped = true;
      continue;
    }
    if (/^── Parameter Tree\b/.test(sec) && /\bFLINE\b/.test(sec)) {
      const lines = sec.split('\n');
      const start = lines.findIndex((l) => /^ {2}FORMULATAB\b/.test(l));
      let end = start + 1;
      while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
      const block = lines.slice(start, end);
      const multi = block.filter((l) => /^\s+\| /.test(l)).map((l) => l.replace(/^\s+\| /, '').trimEnd());
      const single = block.map((l) => l.match(/\bFLINE\b.*$/) ? undefined : l.match(/Blank: "(.*)"\s*$/)?.[1]).filter((x): x is string => x !== undefined);
      fox = multi.length ? multi : single.filter((x) => x.trim() && !/^\d+$/.test(x.trim())).map((x) => x.trimEnd());
      const rest = [...lines.slice(0, start), ...lines.slice(end)];
      if (rest.some((l, i) => i > 0 && l.trim())) out.push(rest.join('\n').trimEnd());
      continue;
    }
    if (/^── Characteristic Usage\b/.test(sec)) {
      // The words a PLSE spec uses, so a read can be written back as it is.
      out.push(sec.trimEnd().replace(/\[(FIELDS_TO_BE_CHANGED|FIELD_FOR_CONDITIONS|NONE)\]/g, (_m, u: string) => ({ FIELDS_TO_BE_CHANGED: 'changed', FIELD_FOR_CONDITIONS: 'condition', NONE: 'none' })[u] ?? u));
      continue;
    }
    out.push(sec.trimEnd());
  }
  if (fox?.length) out.push(['── Formula (FOX) ──', ...fox.map((l) => `  ${l}`)].join('\n'));
  if (dropped) out.push('(detail="full" adds the function type\'s documentation and parameter catalogue)');
  return out.join('\n\n');
}

export const plseAdapter: ObjectAdapter = {
  ...reader({ type: 'PLSE', label: 'Planning function', collection: 'plse', version: 'a', text: (c, n) => bwGetPlanningFunction(c, n), condense: condensePlse }),
  describe(action) {
    return [
      `PLSE ${action} spec (planning function)${action === 'update' ? ' — only the named parts change' : ''}`,
      ...(action === 'create'
        ? [
            '  level            aggregation level                                    (required)',
            '  function_type    0RSPL_FORMULA | 0RSPL_COPY | 0RSPL_DELETE | 0RSPL_REPOST | … or a custom type (required)',
            '  info_area        default: that of the aggregation level',
          ]
        : []),
      `  description      text, max 60${action === 'create' ? '                                         (required)' : ''}`,
      '  characteristics  {CHARACTERISTIC: changed | condition | none}; every one not "changed" is a',
      '                   block characteristic (the function runs per combination of their values)',
      '  conditions       per characteristic with usage condition, in the selection format',
      '                   (op eq|ne|between|gt|ge|lt|le) or {field, variable}; values [] removes one',
      '  parameters       [{name (or PATH/NAME), value | variable, row, key_figures [names] | ["*"],',
      '                   selection [selection format]}], as bw_read shows the parameter tree',
      '  fox              FOX code of a formula function (its FLINE parameter); lines split at \\n.',
      '                   Every operand names the key figure and then each "changed" characteristic:',
      '                   {ZAMOUNT, M} with 0CALMONTH changed; without one it is {ZAMOUNT}',
      '  rule             1-based rule of types with several rules (default 1)',
      'Name at most 20 characters. Saved active.',
      'Example',
      '  {"action":"create","type":"PLSE","name":"ZCW_PF_UP","spec":{"level":"ZCW_AL1","function_type":"0RSPL_FORMULA","description":"Plus 10%","characteristics":{"0CALMONTH":"changed"},"fox":"DATA M TYPE 0CALMONTH.\\nFOREACH M.\\n{ZAMOUNT, M} = {ZAMOUNT, M} * \'1.1\'.\\nENDFOR."}}',
    ].join('\n');
  },
  check(action, name, spec) {
    if (action === 'delete') return [];
    const s = (spec ?? {}) as Rec;
    const props = action === 'create' ? { ...PLSE_PROPS, level: { type: 'string' }, function_type: { type: 'string' }, info_area: { type: 'string' } } : PLSE_PROPS;
    const errors = validateArgs({ type: 'object', properties: props, additionalProperties: false }, s as JsonObject).errors.filter((m) => !/^(conditions|parameters)/.test(m));
    if (action === 'create') {
      if (!NAME_20.test(name)) errors.push('name: 3 to 20 characters, letters, digits and _ (BW keeps at most 20 for a planning function)');
      for (const k of ['level', 'function_type', 'description']) if (typeof s[k] !== 'string') errors.push(`${k}: required`);
    } else for (const k of ['level', 'function_type']) if (s[k] !== undefined) errors.push(`${k}: cannot change`);
    checkSelections(s['conditions'], 'conditions', ['eq', 'between', 'gt', 'ge', 'lt', 'le'], errors, true);
    ((s['parameters'] as Rec[] | undefined) ?? []).forEach((p, i) => {
      errors.push(...validateArgs(PARAMETER, p as JsonObject).errors.filter((m) => !/^selection/.test(m)).map((m) => `parameters[${i}].${m}`));
      checkSelections(p?.['selection'], `parameters[${i}].selection`, ['eq', 'between', 'gt', 'ge', 'lt', 'le'], errors, true);
    });
    return errors;
  },
  dependsOn(action, _n, spec) {
    const s = (spec ?? {}) as Rec;
    const refs: ObjectRef[] = action === 'create' && typeof s['level'] === 'string' ? [{ type: 'ALVL', name: s['level'].toUpperCase() }] : [];
    for (const c of (Array.isArray(s['conditions']) ? s['conditions'] : []) as Rec[]) if (typeof c['variable'] === 'string') refs.push({ type: 'VARIABLE', name: c['variable'].toUpperCase() });
    return refs;
  },
  targetInfoArea: (_n, spec) => (typeof (spec as Rec)['info_area'] === 'string' ? String((spec as Rec)['info_area']).toUpperCase() : undefined),
  boundary: (spec) => (typeof (spec as Rec)['level'] === 'string' ? [{ type: 'ALVL', name: String((spec as Rec)['level']).toUpperCase() }] : []),
  async create(name, spec, ctx) {
    return createClean(ctx.client, 'plse', name, async () => {
      const s = spec as Rec;
      ok(
        await bwCreatePlanningFunction(ctx.client, name, {
          ...functionChanges(s),
          aggregationLevel: String(s['level']).toUpperCase(),
          functionType: String(s['function_type']).toUpperCase(),
          label: String(s['description']),
          ...(typeof s['info_area'] === 'string' ? { infoArea: s['info_area'].toUpperCase() } : {}),
          package: ctx.package,
          ...(ctx.transport ? { transport: ctx.transport } : {}),
        }),
        `Planning function ${name}`,
      );
      return { status: 'created', activated: true, notes: [`${String(s['function_type']).toUpperCase()} on ${String(s['level']).toUpperCase()}`] };
    });
  },
  async update(name, spec, ctx) {
    const changes = functionChanges(spec as Rec);
    const parts = Object.keys(changes).filter((k) => k !== 'rule');
    if (!parts.length) return { status: 'unchanged' };
    const text = ok(await bwUpdatePlanningFunction(ctx.client, name, { ...changes, ...(ctx.transport ? { transport: ctx.transport } : {}) } as PlanningFunctionChanges), `Planning function ${name}`);
    if (/\bnothing (was )?(changed|saved)\b|no change/i.test(text)) return { status: 'unchanged' };
    return { status: 'changed', activated: true, notes: parts.map((p) => ({ charUsage: 'characteristics', parameters: 'parameters', conditions: 'conditions', description: 'description' })[p] ?? p) };
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'plse', name);
    return { status: 'deleted' };
  },
};

// ── Planning sequence ─────────────────────────────────────────────────────────

const STEP: JsonObject = {
  type: 'object',
  properties: { level: { type: 'string' }, filter: { type: 'string' }, function: { type: 'string' }, input: { type: 'boolean' } },
  required: ['level', 'filter'],
  additionalProperties: false,
};

function stepsOf(list: unknown): SequenceStepInput[] {
  return ((Array.isArray(list) ? list : []) as Rec[]).map((st) => ({
    type: typeof st['function'] === 'string' ? 'planning_function' : 'input_template',
    aggregation_level: String(st['level']).toUpperCase(),
    filter: String(st['filter']).toUpperCase(),
    ...(typeof st['function'] === 'string' ? { planning_function: st['function'].toUpperCase() } : {}),
  }));
}

export const plsqAdapter: ObjectAdapter = {
  ...reader({ type: 'PLSQ', label: 'Planning sequence', collection: 'plsq', version: 'a', text: (c, n) => bwGetPlanningSequence(c, n) }),
  describe(action) {
    return [
      `PLSQ ${action} spec (planning sequence)`,
      `  description   text, max 60${action === 'create' ? '                                            (required)' : ''}`,
      `  steps         ${action === 'update' ? 'complete list, ' : ''}in execution order: {level, filter, function} runs a planning`,
      '                function on what the filter selects; {level, filter, input: true} is an input template',
      ...(action === 'create' ? ['  info_area     default: that of the first step\'s aggregation level'] : []),
      'Saved active.',
      'Example',
      '  {"action":"create","type":"PLSQ","name":"ZCW_SEQ1","spec":{"description":"Plan EU","steps":[{"level":"ZCW_AL1","filter":"ZCW_F1","function":"ZCW_PF_UP"}]}}',
    ].join('\n');
  },
  check(action, name, spec) {
    if (action === 'delete') return [];
    const s = (spec ?? {}) as Rec;
    const errors = validateArgs(
      { type: 'object', properties: { description: { type: 'string', maxLength: 60 }, steps: { type: 'array', items: STEP, minItems: 1 }, ...(action === 'create' ? { info_area: { type: 'string' } } : {}) }, additionalProperties: false },
      s as JsonObject,
    ).errors;
    if (action === 'create') {
      if (!NAME.test(name)) errors.push('name: 3 to 30 characters, letters, digits and _');
      if (typeof s['description'] !== 'string') errors.push('description: required');
      if (!Array.isArray(s['steps'])) errors.push('steps: required');
    }
    ((s['steps'] as Rec[] | undefined) ?? []).forEach((st, i) => {
      if (st && st['function'] !== undefined && st['input'] === true) errors.push(`steps[${i}]: either function or input`);
      if (st && st['function'] === undefined && st['input'] !== true) errors.push(`steps[${i}]: give function, or input: true for an input template`);
    });
    return errors;
  },
  dependsOn(_action, _n, spec) {
    const refs: ObjectRef[] = [];
    for (const st of ((spec as Rec | undefined)?.['steps'] as Rec[] | undefined) ?? []) {
      if (typeof st['level'] === 'string') refs.push({ type: 'ALVL', name: st['level'].toUpperCase() });
      if (typeof st['filter'] === 'string') refs.push({ type: 'FILTER' as BwType, name: st['filter'].toUpperCase() });
      if (typeof st['function'] === 'string') refs.push({ type: 'PLSE', name: st['function'].toUpperCase() });
    }
    return refs;
  },
  targetInfoArea: (_n, spec) => (typeof (spec as Rec)['info_area'] === 'string' ? String((spec as Rec)['info_area']).toUpperCase() : undefined),
  boundary: (spec) => {
    const first = (((spec as Rec)['steps'] as Rec[] | undefined) ?? [])[0];
    return typeof first?.['level'] === 'string' ? [{ type: 'ALVL', name: first['level'].toUpperCase() }] : [];
  },
  async create(name, spec, ctx) {
    return createClean(ctx.client, 'plsq', name, async () => {
      const s = spec as Rec;
      ok(
        await bwCreatePlanningSequence(ctx.client, {
          sequence_name: name,
          description: String(s['description']),
          steps: stepsOf(s['steps']),
          ...(typeof s['info_area'] === 'string' ? { info_area: s['info_area'].toUpperCase() } : {}),
          package: ctx.package,
          ...(ctx.transport ? { transport: ctx.transport } : {}),
        }),
        `Planning sequence ${name}`,
      );
      return { status: 'created', activated: true, notes: [`${(s['steps'] as unknown[]).length} step${(s['steps'] as unknown[]).length === 1 ? '' : 's'}`] };
    });
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    if (!Array.isArray(s['steps']) && typeof s['description'] !== 'string') return { status: 'unchanged' };
    ok(
      await bwUpdatePlanningSequence(ctx.client, {
        sequence_name: name,
        ...(Array.isArray(s['steps']) ? { steps: stepsOf(s['steps']) } : {}),
        ...(typeof s['description'] === 'string' ? { description: s['description'] } : {}),
        ...(ctx.transport ? { transport: ctx.transport } : {}),
      }),
      `Planning sequence ${name}`,
    );
    return { status: 'changed', activated: true, notes: [...(Array.isArray(s['steps']) ? ['steps'] : []), ...(typeof s['description'] === 'string' ? ['description'] : [])] };
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'plsq', name);
    return { status: 'deleted' };
  },
};
