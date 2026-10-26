/**
 * Reusable query components: variables (VARIABLE), calculated and restricted key figures
 * (CKF, RKF) and structures (STRUCTURE).
 *
 * The documents are parsed by the proven readers in src/legacy/cp_components.ts, which return
 * JSON. The summary keeps what a model needs to use the component; detail="full" adds the
 * metadata and the dependency list, "raw" returns the parsed form unchanged.
 */
import type { BwClient } from '../bw/client.js';
import { bwSeg } from '../bw/client.js';
import type { BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import { bwGetCkf, bwGetRkf, bwGetStructure, bwGetVariable } from '../legacy/cp_components.js';
import { bwDelete } from '../legacy/delete.js';
import {
  bwCreateCkf,
  bwCreateStructure,
  bwUpdateCkf,
  bwUpdateRkf,
  bwUpdateStructure,
  bwUpdateVariable,
  type StructureMemberSpec,
  type StructureOperation,
  type UpdateCkfArgs,
  type UpdateRkfArgs,
  type UpdateVariableArgs,
} from '../legacy/elem_write.js';
import { ckfAccept, rkfAccept, structureAccept, variableAccept } from '../legacy/query.js';
import type { FormulaNode } from '../legacy/query_update.js';
import { bwCreateRkf } from '../legacy/rkf_create.js';
import {
  bwCreateVariable,
  FORMULA_DIMENSIONS,
  TEXT_REPLACEMENT_INTERVALS,
  TEXT_REPLACEMENT_TYPES,
  type CreateVariableArgs,
  type FormulaDimension,
} from '../legacy/variable.js';
import {
  isNotFound,
  PROVIDER,
  type ObjectAdapter,
  type ObjectRef,
  type ReadOptions,
  type Spec,
  type WriteAction,
  type WriteContext,
  type WriteOutcome,
} from './adapter.js';
import {
  checkMemberProperties,
  checkSelections,
  EXCEPTION_AGGREGATION,
  exceptionAggregationOf,
  formulaOf,
  formulaText,
  MEMBER_PROPERTIES,
  memberPropertiesOf,
  QUERY_OPS,
  restrictionsOf,
  RKF_OPS,
  rkfRestrictionsOf,
  type FormulaContext,
} from './qspec.js';

type Rec = Record<string, unknown>;

const PROCESSING: Record<string, string> = {
  UserEntry: 'user entry',
  CustomerExit: 'customer exit',
  ReplacementPath: 'replacement path',
  SAPExit: 'SAP exit',
  Authorization: 'authorization',
  Precalculated: 'precalculated',
};

const KIND: Record<string, string> = {
  CharacteristicValue: 'characteristic value',
  HierarchyNode: 'hierarchy node',
  Hierarchy: 'hierarchy',
  Formula: 'formula',
  Text: 'text',
};

const words = (v: unknown) => String(v ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function location(j: Rec): string {
  return [j['info_area'] ? `InfoArea ${j['info_area']}` : '', j['package'] ? `package ${j['package']}` : ''].filter(Boolean).join(' · ');
}

function metaLines(j: Rec): string[] {
  const out = [
    j['uid'] ? `uid ${j['uid']}` : '',
    j['authored_by'] ? `authored with ${j['authored_by']}` : '',
    j['changed_at'] ? `changed ${j['changed_at']} by ${j['changed_by'] ?? '?'}` : '',
  ].filter(Boolean);
  return out.length ? [out.join(' · ')] : [];
}

function dependencyLines(j: Rec): string[] {
  const deps = (j['dependencies'] as Rec[] | undefined) ?? [];
  if (!deps.length) return [];
  return [`Uses: ${deps.map((d) => `${d['component_type'] ?? d['type'] ?? ''} ${d['technical_name'] ?? d['technicalName'] ?? d['name'] ?? ''}`.trim()).join(', ')}`];
}

/** Spec words for the enumerations BW stores, so a read result can be written back. */
export const SPEC_WORDS: Record<string, Record<string, string>> = {
  kind: { CharacteristicValue: 'characteristic', Hierarchy: 'hierarchy', HierarchyNodes: 'hierarchy_node', HierarchyNode: 'hierarchy_node', Formula: 'formula', Text: 'text' },
  processing: { UserEntry: 'user_entry', CustomerExit: 'customer_exit', Authorization: 'authorization', ReplacementPath: 'replacement_path', SAPExit: 'sap_exit', Precalculated: 'precalculated' },
  selection: { SingleValue: 'single', SeveralSingleValues: 'multiple', Interval: 'interval', SelectionOption: 'selection_option' },
  input: { Optional: 'optional', MandatoryWithInitial: 'mandatory', MandatoryWithoutInitial: 'mandatory_not_initial' },
};
const spec = (group: string, v: unknown) => SPEC_WORDS[group][String(v)] ?? words(v);

export function summarizeVariable(j: Rec, detail: 'summary' | 'full'): string {
  const type = String(j['variable_type'] ?? '');
  const bits = [
    `${spec('kind', type)}${j['info_object'] && !String(j['info_object']).startsWith('1') ? ` on ${j['info_object']}` : ''}`,
    `processing ${spec('processing', j['processing_type'])}`,
    j['represents'] ? `selection ${spec('selection', j['represents'])}` : '',
    j['input_type'] ? `input ${spec('input', j['input_type'])}` : '',
    j['processing_type'] === 'UserEntry' ? (j['ready_for_input'] ? 'ready for input' : 'not ready for input') : '',
  ].filter(Boolean);
  const head = `VARIABLE ${j['technical_name']} "${j['description'] ?? ''}" · ${bits.join(' · ')}${location(j) ? ` · ${location(j)}` : ''}`;
  const extra: string[] = [];
  for (const [k, label] of [
    ['default_value', 'default'],
    ['default_values', 'defaults'],
    ['replacement', 'replaced from'],
    ['replacement_path', 'replaced from'],
    ['dimension', 'dimension'],
    ['currency', 'currency'],
    ['unit', 'unit'],
  ] as const) {
    const v = j[k];
    if (v !== undefined && v !== null && v !== '') extra.push(`${label} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  const lines = [head, ...(extra.length ? [extra.join(' · ')] : [])];
  return (detail === 'full' ? [...lines, ...metaLines(j)] : lines).join('\n');
}

export function summarizeCkf(j: Rec, detail: 'summary' | 'full'): string {
  const ea = j['exception_aggregation'] as Rec | null | undefined;
  const refs = ea ? ((ea['reference_characteristics'] as string[] | undefined) ?? (ea['reference_characteristic'] ? [String(ea['reference_characteristic'])] : [])) : [];
  const lines = [
    `CKF ${j['technical_name']} "${j['description'] ?? ''}" · on ${j['provider_name'] || '?'}${location(j) ? ` · ${location(j)}` : ''}`,
    `Formula: ${j['formula_tree'] ? formulaText(j['formula_tree'] as FormulaNode) : j['formula'] || '(empty)'}`,
    ...(ea ? [`Exception aggregation: ${ea['type']}${refs.length ? ` over ${refs.join(', ')}` : ''}${ea['exclude'] ? ' (all others)' : ''}`] : []),
    ...dependencyLines(j),
  ];
  return (detail === 'full' ? [...lines, ...metaLines(j)] : lines).join('\n');
}

const OP_WORD: Record<string, string> = {
  Equal: 'eq', Between: 'between', GreaterThan: 'gt', GreaterEqual: 'ge', LessThan: 'lt', LessEqual: 'le', Contains: 'pattern', NotEqual: 'ne',
};

/** Restrictions of a selection member, in the selection format's words: "0CALMONTH: between 202601..202606". */
export function restrictionLines(xml: string): string[] {
  const out: string[] = [];
  for (const g of xml.matchAll(/<Qry:groups\b[^>]*\binfoObject="([^"]+)"[^>]*>([\s\S]*?)<\/Qry:groups>/g)) {
    if (g[1] === '1KYFNM') continue;
    const tokens: string[] = [];
    for (const t of g[2].matchAll(/<Qry:tokens\b([^>]*)>([\s\S]*?)<\/Qry:tokens>/g)) {
      const a = (k: string) => t[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
      const val = (tag: string) => {
        const m = t[2].match(new RegExp(`<Qry:${tag}\\b([^>]*)>([\\s\\S]*?)</Qry:${tag}>`));
        if (!m) return undefined;
        return m[1].match(/\binternalValue="([^"]*)"/)?.[1] ?? m[2].match(/<Qry:value>([^<]*)<\/Qry:value>/)?.[1];
      };
      const low = val('fromValue') ?? '';
      const high = val('toValue');
      const variable = t[2].match(/<Qry:variable\b[^>]*\btechnicalName="([^"]+)"/)?.[1];
      tokens.push(`${a('exclude') === 'true' ? 'not ' : ''}${OP_WORD[a('operator') ?? 'Equal'] ?? a('operator')} ${variable ? `variable ${variable}` : low}${high ? `..${high}` : ''}`);
    }
    out.push(`${g[1]}: ${tokens.join('; ')}`);
  }
  return out;
}

export function summarizeRkf(j: Rec, detail: 'summary' | 'full', xml?: string): string {
  const filters = (j['filters'] as Rec[] | undefined) ?? [];
  const f = xml
    ? restrictionLines(xml)
    : filters.map((x) => `${x['exclude'] ? 'not ' : ''}${x['infoObject']} ${((x['values'] as string[] | undefined) ?? []).join(', ')}`);
  const lines = [
    `RKF ${j['technical_name']} "${j['description'] ?? ''}" · on ${j['provider_name'] || '?'}${location(j) ? ` · ${location(j)}` : ''}`,
    `Key figure: ${j['base_measure'] || '?'}`,
    `Restrictions: ${f.join('; ') || 'none'}`,
    ...dependencyLines(j),
  ];
  return (detail === 'full' ? [...lines, ...metaLines(j)] : lines).join('\n');
}

function structureMemberLines(members: Rec[], indent: string, out: string[]): void {
  for (const m of members) {
    const kind = String(m['member_type'] ?? m['type'] ?? '').toLowerCase().replace(/^member/, '') || 'member';
    const what = m['formula'] ?? m['referenced_component'] ?? '';
    const filters = (m['characteristic_filters'] as Rec[] | undefined) ?? [];
    const restr = filters.map((x) => `${x['infoObject']} ${((x['values'] as string[] | undefined) ?? []).join(', ')}`.trim());
    out.push(`${indent}${kind.padEnd(9)} ${m['description'] ?? m['id'] ?? ''}${what ? ` = ${typeof what === 'object' ? JSON.stringify(what) : what}` : ''}${restr.length ? `  [${restr.join('; ')}]` : ''}`);
    const children = (m['child_members'] as Rec[] | undefined) ?? [];
    if (children.length) structureMemberLines(children, `${indent}  `, out);
  }
}

export function summarizeStructure(j: Rec, detail: 'summary' | 'full'): string {
  const members = (j['members'] as Rec[] | undefined) ?? [];
  const lines = [`STRUCTURE ${j['technical_name']} "${j['description'] ?? ''}" · on ${j['provider_name'] || '?'}${location(j) ? ` · ${location(j)}` : ''}`, `Members (${members.length}):`];
  structureMemberLines(members, '  ', lines);
  lines.push(...dependencyLines(j));
  return (detail === 'full' ? [...lines, ...metaLines(j)] : lines).join('\n');
}

interface Kind {
  type: BwType;
  label: string;
  collection: string;
  accept: () => string;
  get: (client: BwClient, name: string) => Promise<string>;
  summarize: (j: Rec, detail: 'summary' | 'full', xml?: string) => string;
  /** The summary needs the document as well (RKF restrictions with their bounds). */
  needsXml?: boolean;
}

// ── Writers ───────────────────────────────────────────────────────────────────

const VAR_KIND: Record<string, CreateVariableArgs['variable_type']> = {
  characteristic: 'CharacteristicValue',
  hierarchy: 'Hierarchy',
  hierarchy_node: 'HierarchyNodes',
  formula: 'Formula',
  text: 'Text',
};
const VAR_PROCESSING: Record<string, NonNullable<CreateVariableArgs['processing_type']>> = {
  user_entry: 'UserEntry',
  customer_exit: 'CustomerExit',
  authorization: 'Authorization',
  replacement_path: 'ReplacementPath',
};
const VAR_SELECTION: Record<string, NonNullable<CreateVariableArgs['represents']>> = {
  single: 'SingleValue',
  multiple: 'SeveralSingleValues',
  interval: 'Interval',
  selection_option: 'SelectionOption',
};
const VAR_INPUT: Record<string, NonNullable<CreateVariableArgs['input_type']>> = {
  optional: 'Optional',
  mandatory: 'MandatoryWithInitial',
  mandatory_not_initial: 'MandatoryWithoutInitial',
};
const DIMENSION: Record<string, FormulaDimension> = Object.fromEntries(FORMULA_DIMENSIONS.map((d) => [d.toLowerCase(), d]));
const TEXT_FROM: Record<string, (typeof TEXT_REPLACEMENT_TYPES)[number]> = { key: 'Key', external: 'ExternalCharacteristic', text: 'Name' };
const TEXT_BOUND: Record<string, (typeof TEXT_REPLACEMENT_INTERVALS)[number]> = { low: 'FromValue', high: 'ToValue', difference: 'Difference' };

const key = (o: Record<string, unknown>, v: unknown) => Object.keys(o).find((k) => o[k] === v);
const enumOf = (o: Record<string, unknown>): JsonObject => ({ type: 'string', enum: Object.keys(o) });

const VARIABLE_UPDATE_PROPS: Record<string, JsonObject> = {
  description: { type: 'string', maxLength: 60 },
  processing: enumOf(VAR_PROCESSING),
  selection: enumOf(VAR_SELECTION),
  input: enumOf(VAR_INPUT),
  ready_for_input: { type: 'boolean' },
  default: {},
  currency: { type: 'string' },
  unit: { type: 'string' },
};
const VARIABLE_CREATE: JsonObject = {
  type: 'object',
  properties: {
    ...VARIABLE_UPDATE_PROPS,
    kind: enumOf(VAR_KIND),
    info_object: { type: 'string' },
    dimension: enumOf(DIMENSION),
    replacement: {
      type: 'object',
      properties: {
        from: enumOf(TEXT_FROM),
        bound: enumOf(TEXT_BOUND),
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 0 },
        variable: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  required: ['description'],
  additionalProperties: false,
};
const VARIABLE_UPDATE: JsonObject = { type: 'object', properties: VARIABLE_UPDATE_PROPS, additionalProperties: false };

function result(json: string, what: string): Rec {
  const r = JSON.parse(json) as Rec;
  if (r['success'] === false) throw new ToolError('validation', `${what}: ${legacyRefusal(r)}`);
  return r;
}

function checkName(name: string, errors: string[]): void {
  if (!/^[A-Z][A-Z0-9_]{2,29}$/i.test(name)) errors.push('name: 3 to 30 characters, letters, digits and _, starting with a letter');
}

const describeVariable = (action: 'create' | 'update') =>
  (action === 'create'
    ? [
        'VARIABLE create spec',
        '  description      text, max 60                                         (required)',
        '  kind             characteristic (default) | hierarchy | hierarchy_node | formula | text',
        '  info_object      the characteristic (required for characteristic, hierarchy, hierarchy_node;',
        '                   for text with processing replacement_path)',
        '  processing       user_entry (default) | customer_exit | authorization | replacement_path',
        '  selection        single (default) | multiple | interval | selection_option',
        '  input            optional (default) | mandatory | mandatory_not_initial',
        '  ready_for_input  true | false (default true for user entry)',
        'formula: dimension number | amount | quantity | price | quota | date | time; default (number);',
        '         currency (amount, price) or unit (quantity, price)',
        'text by replacement_path: replacement {from key | external | text, bound low | high | difference,',
        '         offset, length, variable (a characteristic variable to read the value from)}',
        'A variable has no InfoArea; it is reusable in every query on its characteristic.',
        'Examples',
        '  {"action":"create","type":"VARIABLE","name":"ZCW_V_MONTH","spec":{"description":"Month","info_object":"0CALMONTH","input":"mandatory"}}',
        '  {"action":"create","type":"VARIABLE","name":"ZCW_V_RATE","spec":{"kind":"formula","description":"Rate","dimension":"number","default":1.5}}',
      ]
    : [
        'VARIABLE update spec (only the named properties change)',
        '  description, processing, selection, input, ready_for_input as in create',
        '  default          formula variables: number, or null to remove it',
        '  currency, unit   formula variables',
        'kind and info_object cannot change.',
      ]
  ).join('\n');

export const variableWriter = {
  describe: describeVariable,
  check(action: WriteAction, name: string, spec: Spec | undefined): string[] {
    const errors: string[] = [];
    if (action === 'delete') return errors;
    const s = (spec ?? {}) as Rec;
    if (action === 'create') checkName(name, errors);
    errors.push(...validateArgs(action === 'create' ? VARIABLE_CREATE : VARIABLE_UPDATE, s as JsonObject).errors);
    if (action === 'create') {
      const kind = String(s['kind'] ?? 'characteristic');
      const needsIobj = ['characteristic', 'hierarchy', 'hierarchy_node'].includes(kind) || (kind === 'text' && s['processing'] === 'replacement_path');
      if (needsIobj && !s['info_object']) errors.push(`info_object: required for kind ${kind}${kind === 'text' ? ' by replacement_path' : ''}`);
      if (kind === 'formula' && s['info_object']) errors.push('info_object: not for a formula variable');
      for (const k of ['dimension', 'default', 'currency', 'unit']) if (s[k] !== undefined && kind !== 'formula') errors.push(`${k}: only for kind formula`);
      if (s['replacement'] !== undefined && kind !== 'text') errors.push('replacement: only for kind text');
      if (kind === 'text' && s['processing'] === 'replacement_path' && !s['replacement']) errors.push('replacement: required for a text variable by replacement_path');
    }
    if (s['default'] !== undefined && s['default'] !== null && typeof s['default'] !== 'number') errors.push('default: a number' + (action === 'update' ? ', or null' : ''));
    return errors;
  },
  dependsOn(action: WriteAction, _name: string, spec: Spec | undefined): ObjectRef[] {
    if (action !== 'create') return [];
    const s = (spec ?? {}) as Rec;
    const refs: ObjectRef[] = [];
    if (typeof s['info_object'] === 'string') refs.push({ type: 'IOBJ', name: s['info_object'].toUpperCase() });
    const r = s['replacement'] as Rec | undefined;
    if (typeof r?.['variable'] === 'string') refs.push({ type: 'VARIABLE', name: String(r['variable']).toUpperCase() });
    return refs;
  },
  async create(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome> {
    const s = spec as Rec;
    const r = (s['replacement'] ?? {}) as Rec;
    const kind = VAR_KIND[String(s['kind'] ?? 'characteristic')];
    const args: CreateVariableArgs = {
      variable_name: name,
      description: String(s['description']),
      variable_type: kind,
      ...(typeof s['info_object'] === 'string' ? { iobj_name: s['info_object'].toUpperCase() } : {}),
      ...(s['processing'] ? { processing_type: VAR_PROCESSING[String(s['processing'])] } : {}),
      ...(s['selection'] ? { represents: VAR_SELECTION[String(s['selection'])] } : {}),
      ...(s['input'] ? { input_type: VAR_INPUT[String(s['input'])] } : {}),
      ...(typeof s['ready_for_input'] === 'boolean' ? { ready_for_input: s['ready_for_input'] } : {}),
      ...(s['dimension'] ? { dimension: DIMENSION[String(s['dimension'])] } : {}),
      ...(typeof s['default'] === 'number' ? { default_value: s['default'] } : {}),
      ...(typeof s['currency'] === 'string' ? { currency: s['currency'].toUpperCase() } : {}),
      ...(typeof s['unit'] === 'string' ? { unit: s['unit'].toUpperCase() } : {}),
      ...(r['from'] ? { replacement_type: TEXT_FROM[String(r['from'])] } : {}),
      ...(r['bound'] ? { replacement_interval: TEXT_BOUND[String(r['bound'])] } : {}),
      ...(typeof r['offset'] === 'number' ? { offset_start: r['offset'] } : {}),
      ...(typeof r['length'] === 'number' ? { offset_length: r['length'] } : {}),
      ...(typeof r['variable'] === 'string' ? { replacement_variable: r['variable'].toUpperCase() } : {}),
      package: ctx.package,
      ...(ctx.transport ? { transport: ctx.transport } : {}),
    };
    result(await bwCreateVariable(ctx.client, args), `Variable ${name}`);
    return { status: 'created', activated: true, notes: [KIND[kind ?? 'CharacteristicValue'] ?? String(kind)] };
  },
  async update(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome> {
    const s = spec as Rec;
    const cur = JSON.parse(await bwGetVariable(ctx.client, name)) as Rec;
    const args: UpdateVariableArgs = { variable_name: name, ...(ctx.transport ? { transport_request: ctx.transport } : {}) };
    const notes: string[] = [];
    if (typeof s['description'] === 'string' && s['description'] !== cur['description']) {
      args.description = s['description'];
      notes.push('description');
    }
    if (s['processing'] && VAR_PROCESSING[String(s['processing'])] !== cur['processing_type']) {
      args.processing_type = VAR_PROCESSING[String(s['processing'])];
      notes.push(`processing ${s['processing']}`);
    }
    if (s['selection'] && VAR_SELECTION[String(s['selection'])] !== cur['represents']) {
      args.represents = VAR_SELECTION[String(s['selection'])];
      notes.push(`selection ${s['selection']}`);
    }
    if (s['input'] && VAR_INPUT[String(s['input'])] !== cur['input_type']) {
      args.input_type = VAR_INPUT[String(s['input'])];
      notes.push(`input ${s['input']}`);
    }
    if (typeof s['ready_for_input'] === 'boolean' && s['ready_for_input'] !== cur['ready_for_input']) {
      args.ready_for_input = s['ready_for_input'];
      notes.push(s['ready_for_input'] ? 'ready for input' : 'not ready for input');
    }
    // The reader gives no default, currency or unit for every variable; a given value is written.
    if (s['default'] !== undefined) {
      args.default_value = s['default'] as number | null;
      notes.push(s['default'] === null ? 'default removed' : `default ${s['default']}`);
    }
    if (typeof s['currency'] === 'string') {
      args.currency = s['currency'].toUpperCase();
      notes.push(`currency ${args.currency}`);
    }
    if (typeof s['unit'] === 'string') {
      args.unit = s['unit'].toUpperCase();
      notes.push(`unit ${args.unit}`);
    }
    if (!notes.length) return { status: 'unchanged' };
    result(await bwUpdateVariable(ctx.client, args), `Variable ${name}`);
    return { status: 'changed', activated: true, notes };
  },
};

// Members of a reusable structure (STRUCTURE) and of a query's key figure structure.

export interface MemberEntry {
  kind: 'key_figure' | 'ckf' | 'rkf' | 'formula';
  ref?: string;
  formula?: unknown;
  description?: string;
  restrictions?: unknown;
  props: Rec;
  raw: Rec;
}

const MEMBER_KEYS = ['key_figure', 'ckf', 'rkf', 'formula', 'description', 'restrictions', 'parent', 'position', 'inverse', ...Object.keys(MEMBER_PROPERTIES)];

export function memberEntryOf(v: unknown): MemberEntry {
  if (typeof v === 'string') return { kind: 'key_figure', ref: v.toUpperCase(), props: {}, raw: { key_figure: v } };
  const o = (v ?? {}) as Rec;
  const kind = (['key_figure', 'ckf', 'rkf', 'formula'] as const).find((k) => o[k] !== undefined) ?? 'key_figure';
  const props: Rec = {};
  for (const k of Object.keys(MEMBER_PROPERTIES)) if (o[k] !== undefined && k !== 'description') props[k] = o[k];
  return {
    kind,
    ...(kind !== 'formula' ? { ref: String(o[kind] ?? '').toUpperCase() } : { formula: o['formula'] }),
    ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
    ...(o['restrictions'] !== undefined ? { restrictions: o['restrictions'] } : {}),
    props,
    raw: o,
  };
}

/** Problems of a member list; `formulas` says whether formula members are possible. */
export function checkMemberEntries(list: unknown, path: string, errors: string[], formulas: boolean): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) return void errors.push(`${path}: a list of key figure names or member entries`);
  list.forEach((v, i) => {
    const at = `${path}[${i}]`;
    if (typeof v === 'string') return;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return void errors.push(`${at}: a key figure name or {key_figure | ckf | rkf${formulas ? ' | formula' : ''}, description, …}`);
    const o = v as Rec;
    for (const k of Object.keys(o)) if (!MEMBER_KEYS.includes(k)) errors.push(`${at}.${k}: unknown`);
    const kinds = ['key_figure', 'ckf', 'rkf', 'formula'].filter((k) => o[k] !== undefined);
    if (kinds.length !== 1) errors.push(`${at}: give exactly one of key_figure, ckf, rkf${formulas ? ', formula' : ''}`);
    if (o['formula'] !== undefined) {
      if (!formulas) errors.push(`${at}.formula: a reusable structure takes key figures, CKF and RKF; formulas belong to a query`);
      else {
        if (typeof o['description'] !== 'string') errors.push(`${at}.description: required for a formula`);
        try {
          formulaOf(o['formula'], 'query');
        } catch (e) {
          errors.push(`${at}.${(e as Error).message}`);
        }
      }
      if (o['restrictions'] !== undefined) errors.push(`${at}.restrictions: not for a formula`);
    }
    checkSelections(o['restrictions'], `${at}.restrictions`, QUERY_OPS, errors);
    checkMemberProperties(o, at, errors);
  });
}

/** The text a member gets when none is given: the name of what it shows. */
export const memberText = (e: MemberEntry) => e.description ?? e.ref ?? '';

function structureMemberSpec(e: MemberEntry): StructureMemberSpec {
  return {
    ...(e.kind === 'key_figure' ? { key_figure: e.ref } : { component_name: e.ref }),
    ...(e.description ? { description: e.description } : {}),
    ...(e.restrictions ? { restrictions: restrictionsOf(e.restrictions) } : {}),
    ...(memberPropertiesOf(e.props) ? { properties: memberPropertiesOf(e.props) } : {}),
  };
}

const COMPONENT_COMMON: Record<string, JsonObject> = {
  description: { type: 'string', maxLength: 60 },
  info_area: { type: 'string' },
};

function checkComponent(type: 'CKF' | 'RKF' | 'STRUCTURE', action: WriteAction, name: string, s: Rec, errors: string[]): void {
  if (action === 'create') {
    checkName(name, errors);
    if (typeof s['provider'] !== 'string' || !s['provider']) errors.push('provider: required (the InfoProvider the component belongs to)');
    if (typeof s['description'] !== 'string' || !s['description']) errors.push('description: required');
  } else if (s['provider'] !== undefined) errors.push(`provider: a ${type} cannot move to another InfoProvider`);
  if (typeof s['description'] === 'string' && s['description'].length > 60) errors.push('description: at most 60 characters');
}

/** The InfoProvider of a component is a boundary: its InfoArea must be allowed. */
function providerRef(spec: Spec): ObjectRef[] {
  const p = (spec as Rec)['provider'];
  return typeof p === 'string' && p ? [{ type: PROVIDER, name: p.toUpperCase() }] : [];
}

const describeCkf = (action: 'create' | 'update') =>
  [
    `CKF ${action} spec${action === 'update' ? ' (only the named properties change)' : ''}`,
    ...(action === 'create' ? ['  provider        InfoProvider the CKF belongs to                       (required)'] : []),
    `  description     text, max 60${action === 'create' ? '                                          (required)' : ''}`,
    `  formula         formula text${action === 'create' ? ' (required)' : ''}: key figures by name, ckf:NAME, rkf:NAME,`,
    '                  var:NAME (formula variable), numbers; + - * / ** and BW functions by their',
    '                  code, e.g. NDIV0(ZAMOUNT / ZQUANTITY), MAX(a, b), %(a, b), IF(c, a, b)',
    '  decimals        0-9',
    '  exception_aggregation  {type SUM|MAX|MIN|AVG|AV0|AV1|AV2|CNT|CN0|FIR|LAS|NO1|NO2|NOP|STD|VAR,',
    '                  over: [characteristics, at most 5], all_others}; false = standard aggregation',
    ...(action === 'create' ? ['  info_area       InfoArea of the CKF (default: that of the provider)'] : []),
    'Example',
    '  {"action":"create","type":"CKF","name":"ZCW_PRICE","spec":{"provider":"ZSALESCP","description":"Price","formula":"NDIV0(ZAMOUNT / ZQUANTITY)"}}',
  ].join('\n');

const describeRkf = (action: 'create' | 'update') =>
  [
    `RKF ${action} spec${action === 'update' ? ' (only the named properties change)' : ''}`,
    ...(action === 'create' ? ['  provider       InfoProvider the RKF belongs to                        (required)'] : []),
    `  description    text, max 60${action === 'create' ? '                                           (required)' : ''}`,
    `  key_figure     basic key figure, or a CKF/RKF by name${action === 'create' ? '                 (required)' : ''}`,
    `  restrictions   ${action === 'update' ? 'replace all: ' : ''}list per characteristic, either {field, values, exclude} or`,
    '                 {field, selections: [{op eq|ne|between|gt|ge|lt|le|pattern, low, high, exclude}]}',
    ...(action === 'create' ? ['  info_area      InfoArea of the RKF (default: that of the provider)'] : []),
    'Example',
    '  {"action":"create","type":"RKF","name":"ZCW_AMT_EU","spec":{"provider":"ZSALESCP","description":"Amount EU","key_figure":"ZAMOUNT","restrictions":[{"field":"ZREGION","values":["EU"]}]}}',
  ].join('\n');

const describeStructure = (action: 'create' | 'update') =>
  (action === 'create'
    ? [
        'STRUCTURE create spec (a reusable key figure structure)',
        '  provider      InfoProvider the structure belongs to                  (required)',
        '  description   text, max 60                                           (required)',
        '  members       ordered list: key figure names, or {key_figure | ckf | rkf, description,',
        '                restrictions (as for an RKF, operators eq and between), decimals, scaling,',
        '                visibility hide|always|never, sign_inversion, input_ready, disaggregation,',
        '                constant_selection, calculation}',
        '  info_area     InfoArea of the structure (default: that of the provider)',
        'Example',
        '  {"action":"create","type":"STRUCTURE","name":"ZCW_KFS","spec":{"provider":"ZSALESCP","description":"Key figures","members":["ZAMOUNT",{"rkf":"ZCW_AMT_EU","decimals":0}]}}',
      ]
    : [
        'STRUCTURE update spec',
        '  description        text',
        '  members_add        entries as in create, appended (or at position, under parent)',
        '  members_remove     member texts',
        '  member_properties  [{member (text), decimals, scaling, visibility, …, parent, position}]',
        'A change appears in every query that uses the structure.',
      ]
  ).join('\n');

function componentAdapter(k: Kind, w: Writer): ObjectAdapter {
  return {
    type: k.type,
    label: k.label,
    async locate(client, name) {
      try {
        const j = JSON.parse(await k.get(client, name)) as Rec;
        return { exists: true, infoArea: (j['info_area'] as string) || undefined, package: (j['package'] as string) || undefined, active: true };
      } catch (err) {
        if (isNotFound(err)) return { exists: false };
        throw err;
      }
    },
    async read(client, name, { detail }: ReadOptions) {
      const raw = () => client.get(`/sap/bw/modeling/${k.collection}/${bwSeg(name.toLowerCase())}/a`, k.accept()).then((r) => r.body);
      if (detail === 'raw') return raw();
      const xml = k.needsXml ? await raw() : undefined;
      return k.summarize(JSON.parse(await k.get(client, name)) as Rec, detail === 'full' ? 'full' : 'summary', xml);
    },
    describe: w.describe,
    check: w.check,
    dependsOn: w.dependsOn,
    targetInfoArea: (_name, spec) => ((spec as Rec)['info_area'] ? String((spec as Rec)['info_area']).toUpperCase() : undefined),
    ...(w.boundary ? { boundary: w.boundary } : {}),
    async create(name, spec, ctx) {
      try {
        return await w.create(name, spec, ctx);
      } catch (err) {
        // CKF, RKF and structures are created in two steps: an empty object first, then its
        // content. When the second step fails, the empty object must not stay behind.
        const left = await k.get(ctx.client, name).then(() => true, () => false);
        if (left) await bwDelete(ctx.client, k.collection, name).catch(() => undefined);
        throw err;
      }
    },
    update: w.update,
    async delete(name, ctx) {
      await bwDelete(ctx.client, k.collection, name);
      return { status: 'deleted' };
    },
  };
}

interface Writer {
  describe(action: 'create' | 'update'): string;
  check(action: WriteAction, name: string, spec: Spec | undefined): string[];
  dependsOn(action: WriteAction, name: string, spec: Spec | undefined): ObjectRef[];
  boundary?(spec: Spec): ObjectRef[];
  create(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome>;
  update(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome>;
}

/** Components a formula tree names (ckf:/rkf: operands). */
function formulaComponents(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== 'object') return into;
  const n = node as Rec;
  if (n['type'] === 'component' && typeof n['component_name'] === 'string') into.push(n['component_name']);
  if (n['type'] === 'variable' && typeof n['variable_name'] === 'string') into.push(`VAR:${n['variable_name']}`);
  for (const o of (n['operands'] as unknown[]) ?? []) formulaComponents(o, into);
  return into;
}

function refsOfFormula(f: unknown, context: FormulaContext): ObjectRef[] {
  let tree: unknown;
  try {
    tree = formulaOf(f, context);
  } catch {
    return [];
  }
  return formulaComponents(tree).map((c) => (c.startsWith('VAR:') ? { type: 'VARIABLE' as BwType, name: c.slice(4) } : { type: 'CKF' as BwType, name: c }));
}

const ckfWriter: Writer = {
  describe: describeCkf,
  check(action, name, spec) {
    const errors: string[] = [];
    if (action === 'delete') return errors;
    const s = (spec ?? {}) as Rec;
    for (const k of Object.keys(s)) if (!['provider', 'description', 'formula', 'decimals', 'exception_aggregation', 'info_area'].includes(k)) errors.push(`${k}: unknown`);
    checkComponent('CKF', action, name, s, errors);
    if (action === 'create' && s['formula'] === undefined) errors.push('formula: required');
    if (s['formula'] !== undefined) {
      try {
        formulaOf(s['formula'], 'ckf');
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (s['decimals'] !== undefined && !(Number.isInteger(s['decimals']) && (s['decimals'] as number) >= 0 && (s['decimals'] as number) <= 9)) errors.push('decimals: 0 to 9');
    if (s['exception_aggregation'] !== undefined && s['exception_aggregation'] !== false) errors.push(...validateArgs(EXCEPTION_AGGREGATION, s['exception_aggregation'] as JsonObject).errors.map((m) => `exception_aggregation.${m}`));
    return errors;
  },
  dependsOn(_action, _name, spec) {
    const s = (spec ?? {}) as Rec;
    return s['formula'] !== undefined ? refsOfFormula(s['formula'], 'ckf') : [];
  },
  boundary: providerRef,
  async create(name, spec, ctx) {
    const s = spec as Rec;
    result(
      await bwCreateCkf(ctx.client, {
        provider_name: String(s['provider']).toUpperCase(),
        technical_name: name,
        description: String(s['description']),
        formula: formulaOf(s['formula'], 'ckf'),
        ...(typeof s['decimals'] === 'number' ? { decimals: s['decimals'] } : {}),
        ...(s['exception_aggregation'] !== undefined ? { exception_aggregation: exceptionAggregationOf(s['exception_aggregation']) } : {}),
        ...(s['info_area'] ? { info_area: String(s['info_area']).toUpperCase() } : {}),
        package: ctx.package,
        ...(ctx.transport ? { transport_request: ctx.transport } : {}),
      }),
      `CKF ${name}`,
    );
    return { status: 'created', activated: true, notes: [`on ${String(s['provider']).toUpperCase()}`] };
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const cur = JSON.parse(await bwGetCkf(ctx.client, name)) as Rec;
    const args: UpdateCkfArgs = { component_name: name, ...(ctx.transport ? { transport_request: ctx.transport } : {}) };
    const notes: string[] = [];
    if (typeof s['description'] === 'string' && s['description'] !== cur['description']) {
      args.description = s['description'];
      notes.push('description');
    }
    if (s['formula'] !== undefined) {
      const want = formulaOf(s['formula'], 'ckf');
      if (formulaText(want) !== formulaText(cur['formula_tree'] as FormulaNode)) {
        args.formula = want;
        notes.push('formula');
      }
    }
    if (typeof s['decimals'] === 'number') {
      args.decimals = s['decimals'];
      notes.push(`decimals ${s['decimals']}`);
    }
    if (s['exception_aggregation'] !== undefined) {
      const want = exceptionAggregationOf(s['exception_aggregation']);
      const now = cur['exception_aggregation'] as Rec | null;
      const same = want === false ? !now : !!now && JSON.stringify(exceptionAggregationOf({ type: now['type'], over: now['reference_characteristics'] ?? (now['reference_characteristic'] ? [now['reference_characteristic']] : []), all_others: now['exclude'] })) === JSON.stringify(want);
      if (!same) {
        args.exception_aggregation = want;
        notes.push(want === false ? 'standard aggregation' : `exception aggregation ${(want as { type: string }).type}`);
      }
    }
    if (!notes.length) return { status: 'unchanged' };
    result(await bwUpdateCkf(ctx.client, args), `CKF ${name}`);
    return { status: 'changed', activated: true, notes };
  },
};

const rkfWriter: Writer = {
  describe: describeRkf,
  check(action, name, spec) {
    const errors: string[] = [];
    if (action === 'delete') return errors;
    const s = (spec ?? {}) as Rec;
    for (const k of Object.keys(s)) if (!['provider', 'description', 'key_figure', 'restrictions', 'info_area'].includes(k)) errors.push(`${k}: unknown`);
    checkComponent('RKF', action, name, s, errors);
    if (action === 'create' && typeof s['key_figure'] !== 'string') errors.push('key_figure: required');
    checkSelections(s['restrictions'], 'restrictions', RKF_OPS, errors);
    return errors;
  },
  dependsOn(_action, _name, spec) {
    const k = (spec as Rec | undefined)?.['key_figure'];
    return typeof k === 'string' ? [{ type: 'IOBJ', name: k.toUpperCase() }] : [];
  },
  boundary: providerRef,
  async create(name, spec, ctx) {
    const s = spec as Rec;
    result(
      await bwCreateRkf(ctx.client, {
        provider_name: String(s['provider']).toUpperCase(),
        technical_name: name,
        description: String(s['description']),
        base_key_figure: String(s['key_figure']).toUpperCase(),
        restrictions: rkfRestrictionsOf(s['restrictions']),
        ...(s['info_area'] ? { info_area: String(s['info_area']).toUpperCase() } : {}),
        package: ctx.package,
        ...(ctx.transport ? { transport_request: ctx.transport } : {}),
      }),
      `RKF ${name}`,
    );
    return { status: 'created', activated: true, notes: [`on ${String(s['provider']).toUpperCase()}`] };
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const cur = JSON.parse(await bwGetRkf(ctx.client, name)) as Rec;
    const args: UpdateRkfArgs = { component_name: name, ...(ctx.transport ? { transport_request: ctx.transport } : {}) };
    const notes: string[] = [];
    if (typeof s['description'] === 'string' && s['description'] !== cur['description']) {
      args.description = s['description'];
      notes.push('description');
    }
    if (typeof s['key_figure'] === 'string' && s['key_figure'].toUpperCase() !== String(cur['base_measure'] ?? '').toUpperCase()) {
      args.base_key_figure = s['key_figure'].toUpperCase();
      notes.push(`key figure ${args.base_key_figure}`);
    }
    if (s['restrictions'] !== undefined) {
      // The reader shows values without their bounds' operators; a given list is written.
      args.restrictions = rkfRestrictionsOf(s['restrictions']);
      notes.push('restrictions');
    }
    if (!notes.length) return { status: 'unchanged' };
    result(await bwUpdateRkf(ctx.client, args), `RKF ${name}`);
    return { status: 'changed', activated: true, notes };
  },
};

const structureWriter: Writer = {
  describe: describeStructure,
  check(action, name, spec) {
    const errors: string[] = [];
    if (action === 'delete') return errors;
    const s = (spec ?? {}) as Rec;
    const allowed = action === 'create' ? ['provider', 'description', 'members', 'info_area'] : ['description', 'members_add', 'members_remove', 'member_properties'];
    for (const k of Object.keys(s)) if (!allowed.includes(k)) errors.push(`${k}: ${action === 'update' && k === 'members' ? 'use members_add / members_remove on an existing structure' : 'unknown'}`);
    checkComponent('STRUCTURE', action, name, s, errors);
    checkMemberEntries(s['members'], 'members', errors, false);
    checkMemberEntries(s['members_add'], 'members_add', errors, false);
    if (s['members_remove'] !== undefined && !(Array.isArray(s['members_remove']) && s['members_remove'].every((x) => typeof x === 'string'))) errors.push('members_remove: a list of member texts');
    if (s['member_properties'] !== undefined) {
      if (!Array.isArray(s['member_properties'])) errors.push('member_properties: a list of {member, …}');
      else (s['member_properties'] as Rec[]).forEach((p, i) => {
        if (typeof p?.['member'] !== 'string') errors.push(`member_properties[${i}].member: required (the member text)`);
        checkMemberProperties(p ?? {}, `member_properties[${i}]`, errors);
      });
    }
    return errors;
  },
  dependsOn(_action, _name, spec) {
    const s = (spec ?? {}) as Rec;
    const refs: ObjectRef[] = [];
    for (const v of [...((s['members'] as unknown[]) ?? []), ...((s['members_add'] as unknown[]) ?? [])]) {
      const e = memberEntryOf(v);
      if (e.kind === 'ckf' && e.ref) refs.push({ type: 'CKF', name: e.ref });
      if (e.kind === 'rkf' && e.ref) refs.push({ type: 'RKF', name: e.ref });
    }
    return refs;
  },
  boundary: providerRef,
  async create(name, spec, ctx) {
    const s = spec as Rec;
    const members = ((s['members'] as unknown[]) ?? []).map(memberEntryOf);
    result(
      await bwCreateStructure(ctx.client, {
        provider_name: String(s['provider']).toUpperCase(),
        technical_name: name,
        description: String(s['description']),
        members: members.map(structureMemberSpec),
        ...(s['info_area'] ? { info_area: String(s['info_area']).toUpperCase() } : {}),
        package: ctx.package,
        ...(ctx.transport ? { transport_request: ctx.transport } : {}),
      }),
      `Structure ${name}`,
    );
    return { status: 'created', activated: true, notes: [`on ${String(s['provider']).toUpperCase()}`, `${members.length} members`] };
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const cur = JSON.parse(await bwGetStructure(ctx.client, name)) as Rec;
    const texts = new Set<string>();
    const shows = new Set<string>();
    const walk = (list: Rec[]) =>
      list.forEach((m) => {
        texts.add(String(m['description'] ?? ''));
        if (m['referenced_component']) shows.add(String(m['referenced_component']).toUpperCase());
        walk((m['child_members'] as Rec[]) ?? []);
      });
    walk((cur['members'] as Rec[]) ?? []);
    const ops: StructureOperation[] = [];
    const notes: string[] = [];
    for (const v of (s['members_add'] as unknown[]) ?? []) {
      const e = memberEntryOf(v);
      // Without a text of its own, a member is known by what it shows (BW names it after that).
      if (e.description ? texts.has(e.description) : e.ref !== undefined && shows.has(e.ref)) continue;
      const parent = (e.raw['parent'] as string | undefined) ?? undefined;
      ops.push({ action: 'add_member', ...structureMemberSpec(e), ...(parent ? { parent } : {}), ...(typeof e.raw['position'] === 'number' ? { position: e.raw['position'] as number } : {}) });
      notes.push(`added ${memberText(e)}`);
    }
    for (const t of (s['members_remove'] as string[]) ?? []) {
      if (!texts.has(t)) continue;
      ops.push({ action: 'remove_member', description: t });
      notes.push(`removed ${t}`);
    }
    for (const p of (s['member_properties'] as Rec[]) ?? []) {
      const props = memberPropertiesOf(p);
      ops.push({
        action: 'set_member_properties',
        description: String(p['member']),
        ...(props ? { properties: props } : {}),
        ...(typeof p['parent'] === 'string' ? { parent: p['parent'] } : {}),
        ...(typeof p['position'] === 'number' ? { position: p['position'] } : {}),
      });
      notes.push(`${p['member']} properties`);
    }
    if (typeof s['description'] === 'string' && s['description'] !== cur['description']) notes.push('description');
    if (!ops.length && !notes.includes('description')) return { status: 'unchanged' };
    const r = result(
      await bwUpdateStructure(ctx.client, {
        component_name: name,
        operations: ops,
        ...(typeof s['description'] === 'string' && s['description'] !== cur['description'] ? { description: s['description'] } : {}),
        ...(ctx.transport ? { transport_request: ctx.transport } : {}),
      }),
      `Structure ${name}`,
    );
    return r['changed'] === false ? { status: 'unchanged' } : { status: 'changed', activated: true, notes };
  },
};

export const variableAdapter = componentAdapter(
  { type: 'VARIABLE', label: 'Variable', collection: 'variable', accept: variableAccept, get: (client, name) => bwGetVariable(client, name), summarize: summarizeVariable },
  variableWriter,
);
export const ckfAdapter = componentAdapter({ type: 'CKF', label: 'Calculated key figure', collection: 'ckf', accept: ckfAccept, get: bwGetCkf, summarize: summarizeCkf }, ckfWriter);
export const rkfAdapter = componentAdapter({ type: 'RKF', label: 'Restricted key figure', collection: 'rkf', accept: rkfAccept, get: bwGetRkf, summarize: summarizeRkf, needsXml: true }, rkfWriter);
export const structureAdapter = componentAdapter(
  { type: 'STRUCTURE', label: 'Structure', collection: 'structure', accept: structureAccept, get: bwGetStructure, summarize: summarizeStructure },
  structureWriter,
);
