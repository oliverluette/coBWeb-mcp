/**
 * Writing queries: create (empty or as a copy) and the update sections of the QUERY spec.
 *
 * Each section runs through its own proven document writer in src/legacy/ (one locked save per
 * section), in a fixed order: layout, members, filter, characteristics, settings, cells, roles.
 * The declarative sections (areas of the layout, filter per characteristic, members) are
 * compared with the query first, so writing the same spec again changes nothing.
 */
import type { BwClient } from '../bw/client.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import { bwCreateQuery } from '../legacy/query.js';
import { bwUpdateQueryCells, type CellOperation } from '../legacy/query_cells.js';
import { bwUpdateQueryCharacteristic, type CharacteristicSpec } from '../legacy/query_characteristic.js';
import {
  bwUpdateQueryFilter,
  bwUpdateQueryKeyFigures,
  bwUpdateQueryLayout,
  bwUpdateQuerySettings,
  type FilterOperation,
  type KeyFigureOperation,
  type LayoutOperation,
  type UpdateQuerySettingsArgs,
} from '../legacy/query_update.js';
import { bwSetQueryRoles } from '../legacy/roles.js';
import { bwDelete } from '../legacy/delete.js';
import { PROVIDER, type ObjectRef, type Spec, type WriteAction, type WriteContext, type WriteOutcome } from './adapter.js';
import { checkMemberEntries, memberEntryOf, type MemberEntry } from './components.js';
import {
  checkMemberProperties,
  checkSelections,
  exceptionAggregationOf,
  filterValuesOf,
  formulaOf,
  memberPropertiesOf,
  QUERY_OPS,
  restrictionsOf,
} from './qspec.js';

type Rec = Record<string, unknown>;
type Axis = 'rows' | 'columns' | 'free';
const AXES: Axis[] = ['rows', 'columns', 'free'];

// ── Spec check ────────────────────────────────────────────────────────────────

const SETTINGS: JsonObject = {
  type: 'object',
  properties: {
    zero_suppression: { type: 'object', properties: { rows: { type: 'boolean' }, columns: { type: 'boolean' } }, additionalProperties: false },
    result_position: { type: 'object', properties: { top: { type: 'boolean' }, left: { type: 'boolean' } }, additionalProperties: false },
    sign: { type: 'string', enum: ['inFrontOf', 'after', 'inParentheses'] },
    zero_as: { type: 'string' },
    suppress_repeated_keys: { type: 'boolean' },
    show_scaling_factor: { type: 'boolean' },
    adjust_formatting: { type: 'boolean' },
    document_links: { type: 'object', properties: { info_provider: { type: 'boolean' }, master_data: { type: 'boolean' }, meta_data: { type: 'boolean' } }, additionalProperties: false },
    display_hierarchy: {
      type: 'object',
      properties: {
        rows: { type: 'object', properties: { active: { type: 'boolean' }, level: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        columns: { type: 'object', properties: { active: { type: 'boolean' }, level: { type: 'integer', minimum: 0 } }, additionalProperties: false },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const CHARACTERISTIC: JsonObject = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    area: { type: 'string', enum: AXES },
    display: { type: 'string', enum: ['key', 'text', 'key_text', 'text_key', 'none', 'default'] },
    text: { type: 'string', enum: ['standard', 'short', 'medium', 'long'] },
    result_rows: { type: 'string', enum: ['always', 'if_more', 'never', 'default'] },
    access: { type: 'string', enum: ['master_data', 'relations', 'posted', 'dimension', 'default'] },
    cumulate: { type: 'string', enum: ['on', 'off', 'default'] },
    display_level: { type: 'string', enum: ['simple', 'normal', 'detailed', 'default'] },
    sorting: {
      type: 'object',
      properties: { by: { type: 'string', enum: ['key', 'text', 'default'] }, direction: { type: 'string', enum: ['ascending', 'descending'] }, attribute: { type: 'string' } },
      required: ['by'],
      additionalProperties: false,
    },
    hierarchy: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        active: { type: 'boolean' },
        version: { type: 'string' },
        valid_to: { type: 'string' },
        expand_to_level: { type: 'integer', minimum: 0 },
        child_nodes: { type: 'string', enum: ['above', 'below', 'default'] },
        posted_node_values: { type: 'string', enum: ['show', 'hide', 'default'] },
        suppress_single_child_nodes: { type: 'string', enum: ['on', 'off', 'default'] },
        sorting: {
          type: 'object',
          properties: { by: { type: 'string', enum: ['key', 'text', 'default'] }, direction: { type: 'string', enum: ['ascending', 'descending'] } },
          required: ['by'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ['field'],
  additionalProperties: false,
};

const CELL: JsonObject = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add_reference', 'add_formula', 'add_help', 'update', 'remove'] },
    row_member: { type: 'string' },
    column_member: { type: 'string' },
    cell: { type: 'string' },
    description: { type: 'string' },
    formula: {},
    key_figure: { type: 'string' },
    restrictions: { type: 'array' },
    decimals: {},
    scaling: {},
  },
  required: ['action'],
  additionalProperties: false,
};

const ROLE: JsonObject = {
  type: 'object',
  properties: { role: { type: 'string' }, folder: { type: 'string' } },
  required: ['role'],
  additionalProperties: false,
};

const UPDATE_KEYS = [
  'description', 'rows', 'columns', 'free', 'filter', 'members', 'members_add', 'members_remove', 'member_properties',
  'members_axis', 'characteristics', 'settings', 'cells', 'roles_add', 'roles_remove',
];

export function checkQuerySpec(action: WriteAction, name: string, spec: Spec | undefined): string[] {
  const errors: string[] = [];
  if (action === 'delete') return errors;
  const s = (spec ?? {}) as Rec;
  const allowed = action === 'create' ? ['provider', 'copy_from', ...UPDATE_KEYS] : UPDATE_KEYS;
  for (const k of Object.keys(s)) if (!allowed.includes(k)) errors.push(`${k}: ${k === 'provider' ? 'the InfoProvider of a query cannot change' : 'unknown'}`);
  if (action === 'create') {
    if (!/^[A-Z][A-Z0-9_]{2,29}$/i.test(name)) errors.push('name: 3 to 30 characters, letters, digits and _, starting with a letter');
    if (typeof s['provider'] !== 'string' && typeof s['copy_from'] !== 'string') errors.push('provider: required (or copy_from)');
  }
  if (s['description'] !== undefined && (typeof s['description'] !== 'string' || s['description'].length > 60)) errors.push('description: text, at most 60 characters');
  const placed = new Map<string, Axis>();
  for (const axis of AXES) {
    const list = s[axis];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`${axis}: a list of characteristics or {structure}`);
      continue;
    }
    list.forEach((e, i) => {
      if (typeof e === 'string') {
        const f = e.toUpperCase();
        if (placed.has(f)) errors.push(`${axis}[${i}]: ${f} is also listed in ${placed.get(f)}`);
        placed.set(f, axis);
      } else if (!(e && typeof e === 'object' && typeof (e as Rec)['structure'] === 'string' && Object.keys(e as Rec).length === 1)) {
        errors.push(`${axis}[${i}]: a characteristic name or {structure: NAME}`);
      } else if (axis === 'free') errors.push(`${axis}[${i}]: a structure goes into rows or columns`);
    });
  }
  checkSelections(s['filter'], 'filter', QUERY_OPS, errors, true);
  if (s['members'] !== undefined && (s['members_add'] !== undefined || s['members_remove'] !== undefined)) errors.push('members: give either the complete list (members) or members_add / members_remove');
  checkMemberEntries(s['members'], 'members', errors, true);
  checkMemberEntries(s['members_add'], 'members_add', errors, true);
  if (s['members_remove'] !== undefined && !(Array.isArray(s['members_remove']) && s['members_remove'].every((x) => typeof x === 'string'))) errors.push('members_remove: a list of member texts');
  if (s['members_axis'] !== undefined && s['members_axis'] !== 'rows' && s['members_axis'] !== 'columns') errors.push('members_axis: rows or columns');
  if (s['member_properties'] !== undefined) {
    if (!Array.isArray(s['member_properties'])) errors.push('member_properties: a list of {member, …}');
    else
      (s['member_properties'] as Rec[]).forEach((p, i) => {
        if (typeof p?.['member'] !== 'string') errors.push(`member_properties[${i}].member: required (text or id of the member)`);
        checkMemberProperties(p ?? {}, `member_properties[${i}]`, errors);
      });
  }
  if (s['characteristics'] !== undefined) {
    if (!Array.isArray(s['characteristics'])) errors.push('characteristics: a list of {field, …}');
    else (s['characteristics'] as Rec[]).forEach((c, i) => errors.push(...validateArgs(CHARACTERISTIC, c as JsonObject).errors.map((m) => `characteristics[${i}].${m}`)));
  }
  if (s['settings'] !== undefined) errors.push(...validateArgs(SETTINGS, s['settings'] as JsonObject).errors.map((m) => `settings.${m}`));
  if (s['cells'] !== undefined) {
    if (!Array.isArray(s['cells'])) errors.push('cells: a list of operations');
    else
      (s['cells'] as Rec[]).forEach((c, i) => {
        errors.push(...validateArgs(CELL, c as JsonObject).errors.map((m) => `cells[${i}].${m}`));
        if (typeof c?.['formula'] === 'string') {
          try {
            formulaOf(c['formula'], 'cell');
          } catch (e) {
            errors.push(`cells[${i}].${(e as Error).message}`);
          }
        }
        checkSelections(c?.['restrictions'], `cells[${i}].restrictions`, QUERY_OPS, errors);
      });
  }
  for (const k of ['roles_add', 'roles_remove']) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k])) errors.push(`${k}: a list of {role, folder}`);
    else (s[k] as Rec[]).forEach((r, i) => errors.push(...validateArgs(ROLE, r as JsonObject).errors.map((m) => `${k}[${i}].${m}`)));
  }
  return errors;
}

export function queryDependsOn(action: WriteAction, _name: string, spec: Spec | undefined): ObjectRef[] {
  if (action === 'delete') return [];
  const s = (spec ?? {}) as Rec;
  const refs: ObjectRef[] = [];
  if (action === 'create' && typeof s['provider'] === 'string') refs.push({ type: PROVIDER, name: s['provider'].toUpperCase() });
  if (action === 'create' && typeof s['copy_from'] === 'string') refs.push({ type: 'QUERY', name: s['copy_from'].toUpperCase() });
  for (const f of (Array.isArray(s['filter']) ? s['filter'] : []) as Rec[]) if (typeof f['variable'] === 'string') refs.push({ type: 'VARIABLE', name: f['variable'].toUpperCase() });
  for (const axis of ['rows', 'columns'] as const)
    for (const e of (Array.isArray(s[axis]) ? s[axis] : []) as unknown[]) if (e && typeof e === 'object') refs.push({ type: 'STRUCTURE', name: String((e as Rec)['structure']).toUpperCase() });
  for (const v of [...((s['members'] as unknown[]) ?? []), ...((s['members_add'] as unknown[]) ?? [])]) {
    const e = memberEntryOf(v);
    if (e.kind === 'ckf' && e.ref) refs.push({ type: 'CKF', name: e.ref });
    if (e.kind === 'rkf' && e.ref) refs.push({ type: 'RKF', name: e.ref });
  }
  return refs;
}

export function queryBoundary(spec: Spec): ObjectRef[] {
  const p = (spec as Rec)['provider'];
  const from = (spec as Rec)['copy_from'];
  // A copy lands in the InfoArea of the provider of the query it copies.
  return [
    ...(typeof p === 'string' && p ? [{ type: PROVIDER, name: p.toUpperCase() }] : []),
    ...(typeof from === 'string' && from ? [{ type: 'QUERY' as ObjectRef['type'], name: from.toUpperCase() }] : []),
  ];
}

// ── Comparing with the query ──────────────────────────────────────────────────

/** Characteristics per area, and the reusable structures there. */
function layoutOf(q: Rec): Record<Axis, { chars: string[]; structures: string[] }> {
  const of = (list: Rec[] | undefined) => {
    const chars: string[] = [];
    const structures: string[] = [];
    for (const d of list ?? []) {
      if (d['type'] === 'CustomDimension') {
        if (d['technicalName']) structures.push(String(d['technicalName']).toUpperCase());
      } else if (d['infoObjectName']) chars.push(String(d['infoObjectName']).toUpperCase());
    }
    return { chars, structures };
  };
  return { rows: of(q['rows'] as Rec[]), columns: of(q['columns'] as Rec[]), free: of(q['freeCharacteristics'] as Rec[]) };
}

export function layoutOperations(q: Rec, s: Rec): LayoutOperation[] {
  const now = layoutOf(q);
  const ops: LayoutOperation[] = [];
  const given = AXES.filter((a) => Array.isArray(s[a]));
  if (!given.length) return ops;
  const want = (a: Axis) => ((s[a] as unknown[]) ?? []).filter((e): e is string => typeof e === 'string').map((e) => e.toUpperCase());
  const wantStructures = (a: Axis) => ((s[a] as unknown[]) ?? []).filter((e) => e && typeof e === 'object').map((e) => String((e as Rec)['structure']).toUpperCase());
  const wantedSomewhere = new Map<string, Axis>();
  for (const a of given) for (const c of want(a)) wantedSomewhere.set(c, a);
  const removed = new Set<string>();
  // Leave an area first: a characteristic not listed in a given area, or listed in another one.
  for (const a of AXES) {
    for (const c of now[a].chars) {
      const target = wantedSomewhere.get(c);
      const leaves = (given.includes(a) && target !== a) || (target !== undefined && target !== a);
      if (leaves && !removed.has(c)) {
        ops.push({ action: 'remove', infoobject: c });
        removed.add(c);
      }
    }
  }
  for (const a of given) {
    for (const c of want(a)) {
      const where = AXES.find((x) => now[x].chars.includes(c));
      if (where === a && !removed.has(c)) continue;
      ops.push({ action: 'add', target: a, infoobject: c });
    }
    if (a === 'free') continue;
    for (const st of now[a].structures) if (!wantStructures(a).includes(st)) ops.push({ action: 'remove_structure', structure_name: st });
    for (const st of wantStructures(a)) if (!now[a].structures.includes(st)) ops.push({ action: 'add_structure', target: a, structure_name: st });
  }
  return ops;
}

const norm = (v: unknown) => String(v ?? '').toUpperCase();

/** "op/low/high/exclude" keys of a filter, from the query or from a spec entry. */
function filterKey(tokens: { operator: string; value: string; high?: string; exclude: boolean }[]): string {
  return tokens
    .map((t) => `${t.operator}/${norm(t.value)}/${norm(t.high)}/${t.exclude}`)
    .sort()
    .join('|');
}

export function filterOperations(q: Rec, list: unknown): FilterOperation[] {
  if (!Array.isArray(list)) return [];
  const current = new Map<string, Rec>();
  for (const f of (q['filter'] as Rec[]) ?? []) if (f['usageType'] !== 'asStartValue') current.set(norm(f['infoObject']), f);
  const ops: FilterOperation[] = [];
  for (const e of list as Rec[]) {
    const field = norm(e['field']);
    const now = current.get(field);
    if (typeof e['variable'] === 'string') {
      if (now && norm((now['variable'] as Rec | undefined)?.['technicalName']) === norm(e['variable'])) continue;
      ops.push({ action: 'set_variable', infoobject: field, variable_name: norm(e['variable']) });
      continue;
    }
    const values = filterValuesOf(e);
    if (!values.length) {
      if (now) ops.push({ action: 'remove', infoobject: field });
      continue;
    }
    const want = filterKey(values.map((v) => ({ operator: v.high !== undefined ? 'Between' : 'Equal', value: v.value, high: v.high, exclude: v.exclude === true })));
    const have = now && !now['variable']
      ? filterKey(((now['fixedValues'] as Rec[]) ?? []).map((t) => ({ operator: String(t['operator']), value: String(t['value'] ?? ''), high: t['highValue'] as string | undefined, exclude: t['exclude'] === true })))
      : undefined;
    if (want === have) continue;
    ops.push({ action: 'set_values', infoobject: field, values });
  }
  return ops;
}

interface QueryMember {
  id: string;
  description: string;
  kind: 'selection' | 'formula';
  /** Key figure or component the selection member shows. */
  shows?: string;
  formula?: string;
  m: Rec;
}

/** Top-level members of the key figure structure (the structure without technical name). */
function keyFigureMembers(q: Rec): { axis?: 'rows' | 'columns'; members: QueryMember[] } {
  for (const axis of ['columns', 'rows'] as const) {
    for (const d of (q[axis] as Rec[]) ?? []) {
      if (d['type'] !== 'CustomDimension' || d['technicalName']) continue;
      const members = ((d['members'] as Rec[]) ?? []).map((m) => {
        let shows: string | undefined;
        for (const g of (m['selections'] as Rec[] | undefined) ?? []) {
          for (const t of (g['tokens'] as Rec[] | undefined) ?? []) {
            if (t['tokenType'] === 'SelectionTokenForComponent') shows = norm(t['componentTechnicalName']);
            else if (g['infoObject'] === '1KYFNM' || t['selectionType'] === 'keyFigure') shows = norm(t['value']);
          }
        }
        return {
          id: String(m['id'] ?? ''),
          description: String(m['description'] ?? ''),
          kind: m['type'] === 'MemberFormula' ? ('formula' as const) : ('selection' as const),
          ...(shows ? { shows } : {}),
          ...(m['formula'] ? { formula: String(m['formula']) } : {}),
          m,
        };
      });
      return { axis, members };
    }
  }
  return { members: [] };
}

/** Formula text compared loosely: BW renders operands by text and adds parentheses. */
const formulaShape = (f: string) => f.replace(/\b(?:ckf|rkf|var|member|cell):/gi, '').replace(/["'()\s]/g, '').toUpperCase();

function matches(e: MemberEntry, m: QueryMember): boolean {
  if (e.description !== undefined) return m.description === e.description;
  if (e.kind === 'formula') return false;
  return m.kind === 'selection' && m.shows !== undefined && m.shows === e.ref;
}

function addOperation(e: MemberEntry, position?: number): KeyFigureOperation {
  const props = memberPropertiesOf(e.props);
  const base: KeyFigureOperation = {
    action: e.kind === 'key_figure' ? 'add_key_figure' : e.kind === 'ckf' ? 'add_ckf' : e.kind === 'rkf' ? 'add_rkf' : 'add_formula',
    ...(e.kind === 'key_figure' ? { infoobject: e.ref } : e.kind === 'formula' ? {} : { component_name: e.ref }),
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.restrictions !== undefined ? { restrictions: restrictionsOf(e.restrictions) } : {}),
    ...(props ? { properties: props } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(typeof e.raw['parent'] === 'string' ? { parent: e.raw['parent'] } : {}),
  };
  if (e.kind === 'formula') {
    base.formula = formulaOf(e.formula, 'query');
    const ea = exceptionAggregationOf(e.props['exception_aggregation']);
    if (ea) base.exception_aggregation = ea;
    if (props) delete props.exception_aggregation;
  }
  return base;
}

export function memberOperations(q: Rec, s: Rec): { ops: KeyFigureOperation[]; notes: string[] } {
  const { members } = keyFigureMembers(q);
  const ops: KeyFigureOperation[] = [];
  const notes: string[] = [];
  if (Array.isArray(s['members'])) {
    const entries = (s['members'] as unknown[]).map(memberEntryOf);
    const used = new Set<string>();
    const order: QueryMember[] = [];
    const rewritten = new Set<string>();
    entries.forEach((e, position) => {
      const hit = members.find((m) => !used.has(m.id) && matches(e, m));
      if (hit) order.push(hit);
      if (!hit) {
        ops.push(addOperation(e, position));
        notes.push(`added ${e.description ?? e.ref}`);
        return;
      }
      used.add(hit.id);
      if (e.kind === 'formula' && hit.formula !== undefined && formulaShape(String(e.formula)) !== formulaShape(hit.formula)) {
        // A formula of a member cannot be edited in place: the member is written again.
        order.pop();
        rewritten.add(hit.id);
        ops.push({ action: 'remove_member', member_id: hit.id });
        ops.push(addOperation(e, position));
        notes.push(`${hit.description} formula`);
        return;
      }
      const props = memberPropertiesOf(e.props);
      if (props && !sameProps(props, hit.m)) {
        ops.push({ action: 'set_member_properties', member_id: hit.id, properties: props });
        notes.push(`${hit.description} properties`);
      }
    });
    for (const m of members) {
      if (used.has(m.id)) continue;
      ops.push({ action: 'remove_member', member_id: m.id });
      notes.push(`removed ${m.description}`);
    }
    // Members that stay keep the order of the list: move those out of place.
    const kept = members.filter((m) => used.has(m.id) && !rewritten.has(m.id));
    if (order.map((m) => m.id).join() !== kept.map((m) => m.id).join()) {
      order.forEach((m, position) => ops.push({ action: 'set_member_properties', member_id: m.id, position }));
      notes.push('order');
    }
  }
  for (const v of (s['members_add'] as unknown[]) ?? []) {
    const e = memberEntryOf(v);
    if (members.some((m) => matches(e, m))) continue;
    ops.push(addOperation(e));
    notes.push(`added ${e.description ?? e.ref}`);
  }
  for (const t of (s['members_remove'] as string[]) ?? []) {
    const hit = members.find((m) => m.description === t || m.id === t);
    if (!hit) continue;
    ops.push({ action: 'remove_member', member_id: hit.id });
    notes.push(`removed ${t}`);
  }
  for (const p of (s['member_properties'] as Rec[]) ?? []) {
    const props = memberPropertiesOf(p);
    const op: KeyFigureOperation = { action: 'set_member_properties', ...(members.some((m) => m.id === p['member']) ? { member_id: String(p['member']) } : { description: String(p['member']) }) };
    if (props) op.properties = props;
    if (typeof p['parent'] === 'string') op.parent = p['parent'];
    if (typeof p['position'] === 'number') op.position = p['position'];
    ops.push(op);
    notes.push(`${p['member']} properties`);
  }
  return { ops, notes };
}

/** The properties a read shows, compared with the wanted ones. */
function sameProps(p: ReturnType<typeof memberPropertiesOf> & object, m: Rec): boolean {
  if (p.decimals !== undefined && p.decimals !== m['decimals']) return false;
  if (p.scaling !== undefined && (p.scaling === false ? (m['scaling'] as Rec | undefined)?.['number'] !== undefined : (m['scaling'] as Rec | undefined)?.['number'] !== p.scaling)) return false;
  if (p.hidden !== undefined && (p.hidden || 'showAlways') !== (m['visibility'] ?? 'showAlways')) return false;
  if (p.sign_inversion !== undefined && p.sign_inversion !== (m['signInversion'] === true)) return false;
  if (p.constant_selection !== undefined && p.constant_selection !== (m['constantSelection'] === true)) return false;
  if (p.description !== undefined && p.description !== m['description']) return false;
  const known = ['decimals', 'scaling', 'hidden', 'sign_inversion', 'constant_selection', 'description'];
  return Object.keys(p).every((k) => known.includes(k));
}

const DISPLAY: Record<string, string> = { key: 'Key', text: 'Text', key_text: 'KeyAndText', text_key: 'TextAndKey', none: 'noDisplay', default: 'default' };
const RESULT_ROWS: Record<string, string> = { always: 'always', if_more: 'suppressForOne', never: 'never', default: 'default' };
const ACCESS: Record<string, string> = { master_data: 'masterdata', relations: 'characteristicRelations', posted: 'factdata', dimension: 'dimensiondata', default: 'default' };
const LEVEL: Record<string, string> = { simple: 'AlsoInSimple', normal: 'Normal', detailed: 'DetailedOnly', default: 'default' };
const BY: Record<string, string> = { key: 'Key', text: 'Text', default: 'default' };
const DIR: Record<string, string> = { ascending: 'Ascending', descending: 'Descending' };

function characteristicSpec(c: Rec): CharacteristicSpec {
  const sort = c['sorting'] as Rec | undefined;
  const h = c['hierarchy'] as Rec | undefined;
  const hs = h?.['sorting'] as Rec | undefined;
  return {
    infoobject: String(c['field']).toUpperCase(),
    ...(c['area'] ? { axis: c['area'] as Axis } : {}),
    ...(c['display'] ? { display_as: DISPLAY[String(c['display'])] as never } : {}),
    ...(c['text'] ? { text_type: c['text'] as never } : {}),
    ...(c['result_rows'] ? { result_rows: RESULT_ROWS[String(c['result_rows'])] as never } : {}),
    ...(c['access'] ? { access_type: ACCESS[String(c['access'])] as never } : {}),
    ...(c['cumulate'] ? { cumulate: c['cumulate'] as never } : {}),
    ...(c['display_level'] ? { display_level: LEVEL[String(c['display_level'])] as never } : {}),
    ...(sort ? { sorting: { by: BY[String(sort['by'])], ...(sort['direction'] ? { direction: DIR[String(sort['direction'])] } : {}), ...(sort['attribute'] ? { sort_by_characteristic: String(sort['attribute']).toUpperCase() } : {}) } as never } : {}),
    ...(h
      ? {
          hierarchy: {
            ...(h['name'] !== undefined ? { name: String(h['name']) } : {}),
            ...(h['active'] !== undefined ? { active: h['active'] } : {}),
            ...(h['version'] !== undefined ? { version: h['version'] } : {}),
            ...(h['valid_to'] !== undefined ? { valid_to: h['valid_to'] } : {}),
            ...(h['expand_to_level'] !== undefined ? { expand_to_level: h['expand_to_level'] } : {}),
            ...(h['child_nodes'] !== undefined ? { child_node_position: h['child_nodes'] } : {}),
            ...(h['posted_node_values'] !== undefined ? { postable_node_values: h['posted_node_values'] } : {}),
            ...(h['suppress_single_child_nodes'] !== undefined ? { suppress_single_child_nodes: h['suppress_single_child_nodes'] } : {}),
            ...(hs ? { sorting: { by: BY[String(hs['by'])], ...(hs['direction'] ? { direction: DIR[String(hs['direction'])] } : {}) } } : {}),
          } as never,
        }
      : {}),
  };
}

/** Settings that differ from the query; undefined when nothing changes. */
export function settingsArgs(q: Rec, name: string, s: Rec | undefined, description: string | undefined): UpdateQuerySettingsArgs | undefined {
  const cur = (q['settings'] as Rec) ?? {};
  const args: UpdateQuerySettingsArgs = { query_name: name };
  let any = false;
  const set = <K extends keyof UpdateQuerySettingsArgs>(k: K, v: UpdateQuerySettingsArgs[K], now: unknown) => {
    if (v === undefined || v === now) return;
    args[k] = v;
    any = true;
  };
  if (description !== undefined) set('description', description, q['description']);
  if (s) {
    const zs = (s['zero_suppression'] ?? {}) as Rec;
    const czs = (cur['zeroSuppression'] ?? {}) as Rec;
    set('zero_suppression_rows', zs['rows'] as boolean | undefined, czs['rows']);
    set('zero_suppression_columns', zs['columns'] as boolean | undefined, czs['columns']);
    const rp = (s['result_position'] ?? {}) as Rec;
    const crp = (cur['resultPosition'] ?? {}) as Rec;
    set('result_position_top', rp['top'] as boolean | undefined, crp['onTop']);
    set('result_position_left', rp['left'] as boolean | undefined, crp['onLeft']);
    set('sign_presentation', s['sign'] as string | undefined, cur['signPresentation']);
    set('suppress_repeated_key_values', s['suppress_repeated_keys'] as boolean | undefined, cur['suppressRepeatedKeyValues']);
    set('show_scaling_factor', s['show_scaling_factor'] as boolean | undefined, cur['showScalingFactor']);
    set('adjust_formatting', s['adjust_formatting'] as boolean | undefined, undefined);
    if (typeof s['zero_as'] === 'string') set('zero_presentation_custom_value', s['zero_as'], undefined);
    if (s['document_links']) set('document_links', s['document_links'] as never, undefined);
    const dh = s['display_hierarchy'] as Rec | undefined;
    if (dh?.['rows']) set('hierarchy_display_rows', dh['rows'] as never, undefined);
    if (dh?.['columns']) set('hierarchy_display_columns', dh['columns'] as never, undefined);
  }
  return any ? args : undefined;
}

const CELL_ACTION: Record<string, CellOperation['action']> = {
  add_reference: 'add_reference_cell',
  add_formula: 'add_formula_cell',
  add_help: 'add_help_cell',
  update: 'update_cell',
  remove: 'remove_cell',
};

function cellOperation(c: Rec): CellOperation {
  return {
    action: CELL_ACTION[String(c['action'])],
    ...(c['row_member'] !== undefined ? { row_member: String(c['row_member']) } : {}),
    ...(c['column_member'] !== undefined ? { column_member: String(c['column_member']) } : {}),
    ...(c['cell'] !== undefined ? { cell: String(c['cell']) } : {}),
    ...(c['description'] !== undefined ? { description: String(c['description']) } : {}),
    ...(c['formula'] !== undefined ? { formula: formulaOf(c['formula'], 'cell') } : {}),
    ...(c['key_figure'] !== undefined ? { key_figure: String(c['key_figure']).toUpperCase() } : {}),
    ...(c['restrictions'] !== undefined ? { restrictions: restrictionsOf(c['restrictions']) } : {}),
    ...(c['decimals'] !== undefined ? { decimals: c['decimals'] as number | false } : {}),
    ...(c['scaling'] !== undefined ? { scaling: c['scaling'] as number | false } : {}),
  };
}

function ok(json: string, what: string): Rec {
  const r = JSON.parse(json) as Rec;
  if (r['success'] === false) throw new ToolError('validation', `${what}: ${legacyRefusal(r)}`);
  return r;
}

// ── Create and update ────────────────────────────────────────────────────────

export async function applyQueryUpdate(
  client: BwClient,
  name: string,
  s: Rec,
  ctx: WriteContext,
  read: () => Promise<Rec>,
  skipDescription = false,
): Promise<string[]> {
  const notes: string[] = [];
  const transport = ctx.transport;
  let q = await read();

  const layout = layoutOperations(q, s);
  if (layout.length) {
    ok(await bwUpdateQueryLayout(client, { query_name: name, operations: layout, ...(transport ? { transport } : {}) }), 'Layout');
    notes.push('layout');
    q = await read();
  }
  const members = memberOperations(q, s);
  if (members.ops.length) {
    const axis = s['members_axis'] === 'rows' ? 'rows' : 'columns';
    // A formula resolves its operands against the saved query, so new formulas follow in a
    // second save, after the members they may refer to.
    const first = members.ops.filter((o) => o.action !== 'add_formula');
    const formulas = members.ops.filter((o) => o.action === 'add_formula');
    for (const batch of [first, formulas]) {
      if (!batch.length) continue;
      ok(await bwUpdateQueryKeyFigures(client, { query_name: name, structure_target: axis, operations: batch, ...(transport ? { transport } : {}) }), 'Members');
    }
    notes.push(...members.notes);
    q = await read();
  }
  const filter = filterOperations(q, s['filter']);
  if (filter.length) {
    ok(await bwUpdateQueryFilter(client, { query_name: name, operations: filter, ...(transport ? { transport } : {}) }), 'Filter');
    notes.push(`filter ${filter.map((f) => f.infoobject).join(', ')}`);
  }
  if (Array.isArray(s['characteristics']) && s['characteristics'].length) {
    ok(await bwUpdateQueryCharacteristic(client, { query_name: name, characteristics: (s['characteristics'] as Rec[]).map(characteristicSpec), ...(transport ? { transport } : {}) }), 'Characteristics');
    notes.push(`characteristics ${(s['characteristics'] as Rec[]).map((c) => String(c['field']).toUpperCase()).join(', ')}`);
  }
  const settings = settingsArgs(q, name, s['settings'] as Rec | undefined, skipDescription ? undefined : (s['description'] as string | undefined));
  if (settings) {
    ok(await bwUpdateQuerySettings(client, { ...settings, ...(transport ? { transport } : {}) }), 'Settings');
    notes.push(settings.description !== undefined && Object.keys(settings).length === 2 ? 'description' : 'settings');
  }
  if (Array.isArray(s['cells']) && s['cells'].length) {
    ok(await bwUpdateQueryCells(client, { query_name: name, operations: (s['cells'] as Rec[]).map(cellOperation), ...(transport ? { transport } : {}) }), 'Cells');
    notes.push(`${(s['cells'] as unknown[]).length} cell change${(s['cells'] as unknown[]).length === 1 ? '' : 's'}`);
  }
  for (const [key, action] of [['roles_add', 'add'], ['roles_remove', 'remove']] as const) {
    for (const r of (s[key] as Rec[] | undefined) ?? []) {
      const folder = typeof r['folder'] === 'string' ? r['folder'] : undefined;
      const text = await bwSetQueryRoles(client, name, action, folder ?? String(r['role']), folder ? 'folder' : 'role', folder ? String(r['role']) : undefined);
      if (/^\s*\{/.test(text)) ok(text, `Role ${r['role']}`);
      notes.push(`${action === 'add' ? 'published in' : 'removed from'} ${r['role']}${folder ? `/${folder}` : ''}`);
    }
  }
  return notes;
}

export async function createQuery(client: BwClient, name: string, s: Rec, ctx: WriteContext, read: () => Promise<Rec>): Promise<WriteOutcome> {
  if (ctx.package.toUpperCase() !== '$TMP') {
    throw new ToolError('validation', `Queries are created in package $TMP for now, not ${ctx.package}.`, 'Create the query in $TMP; transportable packages follow.');
  }
  ok(
    await bwCreateQuery(client, {
      query_name: name,
      ...(typeof s['provider'] === 'string' ? { infoprovider: s['provider'].toUpperCase() } : {}),
      ...(typeof s['description'] === 'string' ? { description: s['description'] } : {}),
      ...(typeof s['copy_from'] === 'string' ? { copy_from: s['copy_from'].toUpperCase() } : {}),
    }),
    `Query ${name}`,
  );
  const notes = [typeof s['copy_from'] === 'string' ? `copied from ${s['copy_from'].toUpperCase()}` : `on ${String(s['provider']).toUpperCase()}`];
  try {
    notes.push(...(await applyQueryUpdate(client, name, s, ctx, read, true)));
  } catch (err) {
    // A create is all or nothing: the query made a moment ago goes again.
    await bwDelete(client, 'query', name).catch(() => undefined);
    const e = err instanceof ToolError ? err : new ToolError('validation', err instanceof Error ? err.message : String(err));
    throw new ToolError(e.kind, `${e.message} (the new query was not kept)`, e.hint);
  }
  return { status: 'created', activated: true, notes };
}
