/**
 * Transformation (TRFN): read. Names are generated keys; source and target identify it.
 */
import { MEDIA_TYPES, bwSeg, freshRead, type BwClient } from '../bw/client.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import type { JsonObject } from '../catalog/tools.js';
import {
  bwCreateTransformation,
  bwDeleteTransformationRoutine,
  bwSetTransformationExpertRoutine,
  bwSetTransformationRoutine,
  bwSetTransformationRoutineFields,
  bwSetTransformationRuntime,
  bwUpdateTransformation,
  targetAggregations,
  type RuleConversion,
} from '../legacy/transformation.js';
import { activateObject } from '../engine/activation.js';
import { bwDelete } from '../legacy/delete.js';
import { xref } from '../tools/relations.js';
import {
  isNotFound,
  locationFromXml,
  statusText,
  type Location,
  type ObjectAdapter,
  type ObjectReader,
  type ObjectRef,
  type ReadOptions,
  type Spec,
  type WriteAction,
} from './adapter.js';
import {
  attr,
  endLabel,
  flowEnd,
  flowIdentity,
  objectStatus,
  parseIdentity,
  sameTitle,
  splitDataSource,
  startTag,
  trfnTitle,
  wrapNames,
  type FlowEnd,
} from './flow.js';

export interface TrfnEnd {
  type: string;
  name: string;
  sourceSystem?: string;
  description?: string;
  /** Part of an InfoObject: texts, attributes or hierarchy. */
  part?: string;
  fields: string[];
}

export interface TrfnRule {
  kind: string;
  sources: string[];
  targets: string[];
  detail?: string;
  /** The rule's XML, for checks the summary does not carry (conversion, lookup object). */
  raw?: string;
}

export interface TrfnModel {
  name: string;
  description: string;
  status?: string;
  package?: string;
  source: TrfnEnd;
  target: TrfnEnd;
  routines: { start?: string; end?: string; expert?: string };
  rules: TrfnRule[];
  hana?: boolean;
}

const STEP_KIND: Record<string, string> = {
  Direct: 'direct',
  DirectAssignment: 'direct',
  Constant: 'constant',
  Formula: 'formula',
  Routine: 'routine',
  Initial: 'initial',
  NoUpdate: 'no update',
  ReadMasterData: 'master data lookup',
  ReadDSO: 'lookup',
  ReadAdso: 'lookup',
  Read: 'lookup',
  Time: 'time conversion',
  UnitConversion: 'unit conversion',
  CurrencyConversion: 'currency conversion',
};

function end(xml: string, element: 'source' | 'target'): TrfnEnd {
  const block = xml.match(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}>`))?.[0] ?? startTag(xml, element);
  const tag = startTag(block, element);
  const type = (attr(tag, 'type') ?? '').toUpperCase();
  const { name, sourceSystem } = splitDataSource(type, attr(tag, 'name') ?? '');
  const segment = block.match(/<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  const fields = [...segment.matchAll(/<element\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
  const sub = (attr(tag, 'subType') ?? '').toUpperCase();
  const part = sub === 'TEXT' ? 'texts' : sub === 'ATTR' ? 'attributes' : sub === 'HIER' ? 'hierarchy' : undefined;
  return { type, name, sourceSystem: sourceSystem ?? attr(tag, 'sourceSystem') ?? undefined, description: attr(tag, 'description') || undefined, ...(part ? { part } : {}), fields };
}

function stepRef(body: string): string | undefined {
  const step = startTag(body, 'step');
  const cls = attr(step, 'classNameM');
  return cls ? `${cls}.${attr(step, 'methodNameM') ?? ''}` : undefined;
}

export function parseTrfn(name: string, xml: string, headerStatus?: string): TrfnModel {
  const root = xml.match(/<trfn:transformation\b[^>]*>/)?.[0] ?? xml.match(/<[A-Za-z]+:[A-Za-z]+\b[^>]*>/)?.[0] ?? '';
  const routines: TrfnModel['routines'] = {
    start: attr(root, 'startRoutine') || undefined,
    end: attr(root, 'endRoutine') || undefined,
    expert: attr(root, 'expertRoutine') || undefined,
  };
  const rules: TrfnRule[] = [];
  for (const m of xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)) {
    const [, attrs, body] = m;
    const routineType = (attr(`<rule ${attrs}>`, 'routinetype') ?? '').toUpperCase();
    if (routineType === 'START' || routineType === 'END' || routineType === 'EXPERT') {
      const key = routineType.toLowerCase() as 'start' | 'end' | 'expert';
      routines[key] = routines[key] ?? stepRef(body) ?? 'yes';
      continue;
    }
    const step = startTag(body, 'step');
    const xsi = (attr(step, 'xsi:type') ?? '').replace(/^.*:Step/, '');
    const kind = STEP_KIND[xsi] ?? (xsi ? xsi.charAt(0).toLowerCase() + xsi.slice(1) : routineType.toLowerCase() || '?');
    const sources = [...body.matchAll(/elementRef>#\/\/\/source\/[^/]+\/([^<]+)<\/elementRef>/g)].map((x) => x[1]);
    const targets = [...body.matchAll(/elementRef>#\/\/\/target\/[^/]+\/([^<]+)<\/elementRef>/g)].map((x) => x[1]);
    let detail: string | undefined;
    if (kind === 'constant') detail = `"${attr(step, 'constant') ?? ''}"`;
    if (kind === 'formula') detail = attr(step, 'formula') ?? body.match(/<formula\b[^>]*>([\s\S]*?)<\/formula>/)?.[1]?.trim();
    if (kind === 'routine') detail = stepRef(body);
    if (kind === 'lookup' && attr(step, 'objectName')) detail = `${attr(step, 'objectType') ?? ''} ${attr(step, 'objectName')}`.trim();
    rules.push({ kind, sources, targets, detail, raw: body });
  }
  const tlogo = startTag(xml, 'tlogoProperties');
  return {
    name: name.toUpperCase(),
    description: attr(root, 'description') ?? attr(tlogo, 'adtcore:description') ?? '',
    status: objectStatus(xml, headerStatus),
    package: locationFromXml(xml).package,
    source: end(xml, 'source'),
    target: end(xml, 'target'),
    routines,
    rules,
    hana: attr(root, 'HANARuntime') === 'true' ? true : attr(root, 'HANARuntime') === 'false' ? false : undefined,
  };
}

export function summarizeTrfn(m: TrfnModel, part?: string): string {
  const head = [
    `TRFN ${m.name} "${m.description}" · ${statusText(m.status)}${m.hana === undefined ? '' : m.hana ? ' · HANA runtime' : ' · ABAP runtime'}`,
    `${endLabel(m.source.type, m.source.name, m.source.sourceSystem)}${m.source.part ? ` (${m.source.part})` : ''} → ${endLabel(m.target.type, m.target.name)}${m.target.part ? ` (${m.target.part})` : ''}`,
  ];
  const r = m.routines;
  const routines = `Routines: start ${r.start ?? 'none'} · end ${r.end ?? 'none'} · expert ${r.expert ?? 'none'}`;
  const mapped = new Set(m.rules.flatMap((x) => x.targets));
  const unmapped = m.target.fields.filter((f) => !mapped.has(f));
  const kw = Math.max(6, ...m.rules.map((x) => x.kind.length));
  const rules = [
    `Rules (${m.rules.length}):`,
    ...m.rules.map((x) =>
      `  ${x.kind.padEnd(kw)}  ${x.sources.join(', ') || '-'} → ${x.targets.join(', ') || '-'}${x.detail ? `  ${x.detail.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`,
    ),
  ];
  if (m.routines.expert) rules.push('The expert routine fills every target field; rules and the end routine do not apply.');
  else if (unmapped.length > 0) rules.push(`Target fields without rule (${unmapped.length}):`, ...wrapNames(unmapped, '  '));
  const fields = [
    `Source fields (${m.source.fields.length}):`,
    ...wrapNames(m.source.fields),
    `Target fields (${m.target.fields.length}):`,
    ...wrapNames(m.target.fields),
  ];
  const p = part?.toLowerCase();
  if (p === 'rules') return [...head, ...rules].join('\n');
  if (p === 'routines') return [...head, routines].join('\n');
  if (p === 'fields') return [...head, ...fields].join('\n');
  return [...head, routines, ...rules].join('\n');
}

async function readDoc(name: string): Promise<{ xml: string; status?: string }> {
  try {
    const r = await freshRead(`/sap/bw/modeling/trfn/${bwSeg(name.toLowerCase())}/m`, MEDIA_TYPES['trfn']);
    return { xml: r.body, status: r.headers['object_status'] ?? r.headers['OBJECT_STATUS'] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 500/.test(msg) && /serialization failed|Serialisierung ist fehlgeschlagen|RS_RES_MODEL/i.test(msg)) {
      throw new ToolError(
        'backend',
        `Transformation ${name.toUpperCase()} cannot be read through the modeling API: BW fails to serialize its model (RS_RES_MODEL 001).`,
        'Retrying does not help. Open it in SAP GUI (RSTRAN).',
      );
    }
    throw err;
  }
}

export const trfnReader: ObjectReader = {
  type: 'TRFN',
  label: 'Transformation',
  async locate(_client: BwClient, name: string) {
    try {
      return locationFromXml((await readDoc(name)).xml);
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },
  async read(_client: BwClient, name: string, { detail, part }: ReadOptions) {
    const { xml, status } = await readDoc(name);
    if (detail === 'raw') return xml;
    const m = parseTrfn(name, xml, status);
    return detail === 'full' && !part ? [summarizeTrfn(m), ...summarizeTrfn(m, 'fields').split('\n').slice(2)].join('\n') : summarizeTrfn(m, part);
  },
};

// ── Writing ──────────────────────────────────────────────────────────────────

const SOURCE_TYPES = ['ADSO', 'HCPR', 'RSDS', 'TRCS', 'IOBJ'];
const TARGET_TYPES = ['ADSO', 'TRCS', 'IOBJ'];
const END: JsonObject = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    name: { type: 'string' },
    source_system: { type: 'string' },
    // InfoObject facet: the text table, the attributes or the hierarchy of a characteristic.
    part: { type: 'string', enum: ['texts', 'attributes', 'hierarchy'] },
  },
  required: ['type', 'name'],
  additionalProperties: false,
};
const PART_SUBTYPE: Record<string, string> = { texts: 'TEXT', attributes: 'ATTR', hierarchy: 'HIER' };
const RULE: JsonObject = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    type: { type: 'string', enum: ['direct', 'constant', 'formula', 'no_update', 'lookup', 'routine'] },
    source: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    value: { type: 'string' },
    formula: { type: 'string' },
    aggregation: { type: 'string', enum: ['SUM', 'MOV', 'MIN', 'MAX', 'NOP'] },
    lookup: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['ADSO', 'IOBJ'] }, name: { type: 'string' } },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    conversion: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['currency', 'unit'] }, name: { type: 'string' }, source_field: { type: 'string' } },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    unit_source: { type: 'string' },
  },
  required: ['target'],
  additionalProperties: false,
};
const CREATE: JsonObject = {
  type: 'object',
  properties: { source: END, target: END, rules: { type: 'array', items: RULE }, copy_from: { type: 'string' } },
  required: ['source', 'target'],
  additionalProperties: false,
};
const ROUTINE: JsonObject = {
  type: 'object',
  properties: { code: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, exclude_fields: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
};
const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    rules: { type: 'array', items: RULE },
    runtime: { type: 'string', enum: ['hana', 'abap'] },
    routines: { type: 'object', properties: { start: {}, end: {}, expert: {} }, additionalProperties: false },
  },
  additionalProperties: false,
};

type RoutineKind = 'start' | 'end' | 'expert';

/** routines.<kind>: "delete" or {code, fields, exclude_fields}; {} creates the routine without code. */
function routineErrors(spec: Spec): string[] {
  const r = spec.routines as JsonObject | undefined;
  if (!r) return [];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === 'delete') continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(`routines.${k}: "delete" or {code, fields, exclude_fields}`);
      continue;
    }
    errors.push(...validateArgs(ROUTINE, v as JsonObject).errors.map((e) => `routines.${k}.${e}`));
    const o = v as JsonObject;
    if ((o.fields !== undefined || o.exclude_fields !== undefined) && k !== 'end') errors.push(`routines.${k}: fields and exclude_fields belong to the end routine`);
    if (o.fields !== undefined && o.exclude_fields !== undefined) errors.push('routines.end: fields or exclude_fields, not both');
    if (typeof o.code === 'string' && !/\bMETHOD\b[\s\S]*\bENDMETHOD\b/i.test(o.code)) errors.push(`routines.${k}.code: the complete METHOD … ENDMETHOD. block`);
  }
  return errors;
}

/** Target fields the END routine writes, as stored. */
export function endTargets(xml: string): string[] {
  const rule = /<rule\b[^>]*\broutinetype="END"[^>]*>[\s\S]*?<\/rule>/.exec(xml)?.[0] ?? '';
  return [...rule.matchAll(/<elementRef>#\/\/\/target\/segment\d+\/([^<]+)<\/elementRef>/g)].map((m) => m[1].toUpperCase());
}

/** Target fields BW keeps in the END routine whatever the list says: the key and the technical fields. */
export function keptEndFields(xml: string): string[] {
  const seg = /<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/.exec(xml)?.[1] ?? '';
  const all = [...seg.matchAll(/<element\b([^>]*)>/g)].map((m) => m[1]);
  return all.filter((a) => /\bkey="true"/.test(a) || /__TECH_FIELDS__/.test(a)).map((a) => (/\bname="([^"]+)"/.exec(a)?.[1] ?? '').toUpperCase());
}

/** Whether the END routine already writes exactly the fields a list or an exclusion asks for. */
export function sameEndFields(xml: string, fields?: string[], exclude?: string[]): boolean {
  const seg = /<target\b[^>]*>[\s\S]*?<segment[^>]*>([\s\S]*?)<\/segment>/.exec(xml)?.[1] ?? '';
  const all = [...seg.matchAll(/<element\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1].toUpperCase());
  const wanted = new Set([...keptEndFields(xml), ...(fields ?? all.filter((f) => !(exclude ?? []).includes(f)))]);
  const stored = new Set(endTargets(xml));
  return wanted.size === stored.size && [...wanted].every((f) => stored.has(f));
}

/** The generated GLOBAL_START of a HANA transformation with its pass-through line switched on. */
async function passThroughStart(client: BwClient, xml: string): Promise<string | undefined> {
  const cls = /\bclassNameM="([^"]+)"/.exec(xml)?.[1] ?? (/\bclassNameA="([^"]+)"/.exec(xml)?.[1] ?? '').replace(/_A$/, '_M');
  if (!cls) return undefined;
  const source = await client.adtGetSource(encodeURIComponent(cls).toLowerCase()).catch(() => null);
  const block = source ? /METHOD\s+GLOBAL_START\b[\s\S]*?ENDMETHOD\s*\./i.exec(source)?.[0] : undefined;
  return block ? passThrough(block) : undefined;
}

export function passThrough(block: string): string {
  return block.replace(/^(\s*)--\s*(outTab\s*=\s*SELECT\s+\*\s+FROM\s+:inTab\s*;)/im, '$1$2');
}

/** Whether the generated class already holds this METHOD … ENDMETHOD. block. */
async function sameRoutineCode(client: BwClient, routine: string, code: string): Promise<boolean> {
  const [cls, method] = routine.split('.');
  if (!cls || !method) return false;
  const source = await client.adtGetSource(encodeURIComponent(cls).toLowerCase()).catch(() => null);
  return source !== null && sameMethod(source, method, code);
}

export function sameMethod(source: string, method: string, code: string): boolean {
  const block = new RegExp(`METHOD\\s+${method.replace(/[/]/g, '\\/')}\\b[\\s\\S]*?ENDMETHOD\\s*\\.`, 'i').exec(source)?.[0];
  const norm = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').join('\n');
  return block !== undefined && norm(block) === norm(code);
}

/** A legacy answer: JSON with success/message/lock_handle, or text. */
function legacyAnswer(text: string, what: string): { handle?: string } {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (r['success'] === false) {
    const details = Array.isArray(r['messages']) ? legacyRefusal({ messages: r['messages'] }) : '';
    throw new ToolError('validation', `${what}: ${legacyRefusal(r)}${details && details !== 'refused' ? ` — ${details}` : ''}`);
  }
  return typeof r['lock_handle'] === 'string' ? { handle: r['lock_handle'] } : {};
}

async function activateNow(ctx: { client: BwClient; transport?: string }, name: string, handle: string, what: string): Promise<void> {
  const act = await activateObject(ctx.client, 'trfn', name, handle, ctx.transport);
  if (!act.ok) throw new ToolError('activation_failed', `${what}: activation failed: ${act.messages.slice(0, 3).join(' / ') || 'no message'}`);
}

/**
 * Global routines and the runtime, each in its own step and activated before the next: the
 * write paths lock, save and leave the activation to the caller, and the code write
 * re-saves the transformation itself.
 */
async function applyRoutines(ctx: { client: BwClient; transport?: string }, name: string, spec: Spec, current: TrfnModel, xml: string): Promise<string[]> {
  try {
    return await routineSteps(ctx, name, spec, current, xml);
  } catch (e) {
    // A refused step can leave the lock of the write before it behind.
    await ctx.client.unlock('trfn', name.toLowerCase()).catch(() => undefined);
    throw e;
  }
}

async function routineSteps(ctx: { client: BwClient; transport?: string }, name: string, spec: Spec, current: TrfnModel, xml: string): Promise<string[]> {
  const notes: string[] = [];
  const r = (spec.routines as JsonObject | undefined) ?? {};
  const ex = r['expert'];
  if (current.hana === true && current.routines.expert === undefined && ex && typeof ex === 'object' && typeof (ex as JsonObject).code !== 'string')
    throw new ToolError('validation', 'routines.expert: under the HANA runtime a new expert routine needs code; its generated stub does not activate.', 'Give code: the complete METHOD GLOBAL_EXPERT BY DATABASE PROCEDURE … ENDMETHOD. block that fills outTab.');
  for (const kind of ['start', 'end', 'expert'] as RoutineKind[]) {
    const v = r[kind];
    if (v === undefined) continue;
    const has = current.routines[kind] !== undefined;
    if (v === 'delete') {
      if (!has) continue;
      const { handle } = legacyAnswer(await bwDeleteTransformationRoutine(ctx.client, name, kind), `${kind} routine`);
      if (handle !== undefined) await activateNow(ctx, name, handle, `${kind} routine removed`);
      notes.push(`${kind} routine removed`);
      continue;
    }
    const o = v as JsonObject;
    // Under HANA the bare stub of a new routine does not activate ("OUTTAB is not assigned"),
    // and an activation of the transformation generates its class anew from BW's metadata,
    // dropping the skeleton the create wrote into it. The code write saves the transformation
    // again after the class, which makes the class code the one that counts. So under HANA, and
    // for any routine given code, that write activates — with the caller's code, or with the
    // class as it is (for a new routine, the skeleton the create put in).
    let code = typeof o.code === 'string' && !(has && (await sameRoutineCode(ctx.client, current.routines[kind]!, o.code))) ? o.code : undefined;
    let pending: string | undefined;
    if (!has) {
      const { handle } = legacyAnswer(await bwSetTransformationRoutine(ctx.client, name, kind, ctx.transport), `${kind} routine`);
      notes.push(`${kind} routine created`);
      pending = handle;
      // The HANA start routine comes with its pass-through line commented out; switched on, the
      // routine activates and hands every record on unchanged.
      if (code === undefined && kind === 'start' && current.hana === true) code = await passThroughStart(ctx.client, (await readDoc(name)).xml);
    }
    if (kind === 'end' && (o.fields !== undefined || o.exclude_fields !== undefined)) {
      const fields = Array.isArray(o.fields) ? o.fields.map((f) => String(f).toUpperCase()) : undefined;
      const exclude = Array.isArray(o.exclude_fields) ? o.exclude_fields.map((f) => String(f).toUpperCase()) : undefined;
      if (!has || !sameEndFields(xml, fields, exclude)) {
        if (pending !== undefined) await ctx.client.unlock('trfn', name.toLowerCase()).catch(() => undefined);
        const { handle } = legacyAnswer(await bwSetTransformationRoutineFields(ctx.client, name, fields, exclude, ctx.transport), 'end routine fields');
        notes.push(`end routine fields ${fields ? fields.join('+') : `all but ${exclude!.join('+')}`}`);
        pending = handle;
      }
    }
    if (code !== undefined || (pending !== undefined && current.hana === true)) {
      if (pending !== undefined) await ctx.client.unlock('trfn', name.toLowerCase()).catch(() => undefined);
      legacyAnswer(await bwSetTransformationExpertRoutine(ctx.client, name, code, kind, ctx.transport), `${kind} routine code`);
      notes.push(typeof o.code === 'string' ? `${kind} routine code written` : 'pass-through code');
    } else if (pending !== undefined) {
      await activateNow(ctx, name, pending, `${kind} routine`);
    }
  }
  return notes;
}

interface RuleSpec {
  target: string;
  type: 'direct' | 'constant' | 'formula' | 'no_update' | 'lookup' | 'routine';
  source?: string;
  sources?: string[];
  value?: string;
  formula?: string;
  aggregation?: string;
  lookup?: { type: string; name: string };
  conversion?: RuleConversion;
  unitSource?: string;
}

function rulesOf(spec: Spec): RuleSpec[] {
  return ((spec.rules as JsonObject[] | undefined) ?? []).map((r) => {
    const type = (r.type as RuleSpec['type'] | undefined) ?? (r.value !== undefined ? 'constant' : r.formula !== undefined ? 'formula' : 'direct');
    return {
      target: String(r.target).toUpperCase(),
      type,
      source: r.source !== undefined ? String(r.source).toUpperCase() : type === 'direct' ? String(r.target).toUpperCase() : undefined,
      value: r.value !== undefined ? String(r.value) : undefined,
      formula: r.formula !== undefined ? String(r.formula) : undefined,
      aggregation: r.aggregation !== undefined ? String(r.aggregation).toUpperCase() : undefined,
      sources: Array.isArray(r.sources) ? r.sources.map((x) => String(x).toUpperCase()) : undefined,
      lookup: r.lookup ? { type: String((r.lookup as JsonObject).type).toUpperCase(), name: String((r.lookup as JsonObject).name).toUpperCase() } : undefined,
      conversion: r.conversion
        ? {
            type: (r.conversion as JsonObject).type as 'currency' | 'unit',
            name: String((r.conversion as JsonObject).name).toUpperCase(),
            ...((r.conversion as JsonObject).source_field !== undefined ? { source_unit_field: String((r.conversion as JsonObject).source_field).toUpperCase() } : {}),
          }
        : undefined,
      unitSource: r.unit_source !== undefined ? String(r.unit_source).toUpperCase() : undefined,
    };
  });
}

function checkRules(rules: unknown, errors: string[]): void {
  if (!Array.isArray(rules)) return;
  const seen = new Set<string>();
  for (const r of rules as JsonObject[]) {
    const t = String(r.target ?? '').toUpperCase();
    if (seen.has(t)) errors.push(`rules: ${t} is listed twice`);
    seen.add(t);
    if (r.type === 'constant' && r.value === undefined) errors.push(`rules: ${t}: value is required for a constant`);
    if (r.type === 'formula' && r.formula === undefined) errors.push(`rules: ${t}: formula is required for a formula`);
    if (r.value !== undefined && r.type !== undefined && r.type !== 'constant') errors.push(`rules: ${t}: value only for type constant`);
    if (r.formula !== undefined && r.type !== undefined && r.type !== 'formula') errors.push(`rules: ${t}: formula only for type formula`);
    if (r.source !== undefined && r.type !== undefined && !['direct', 'lookup', 'routine'].includes(String(r.type))) errors.push(`rules: ${t}: source only for direct, lookup or routine`);
    if (r.type === 'lookup' && (r.lookup === undefined || r.source === undefined)) errors.push(`rules: ${t}: a lookup needs source (the key field) and lookup {type, name}`);
    if (r.lookup !== undefined && r.type !== 'lookup') errors.push(`rules: ${t}: lookup only for type lookup`);
    if (r.conversion !== undefined && (r.type ?? 'direct') !== 'direct') errors.push(`rules: ${t}: conversion only for direct rules`);
    if (r.conversion !== undefined && r.unit_source !== undefined) errors.push(`rules: ${t}: give either conversion or unit_source`);
    if (r.unit_source !== undefined && (r.type ?? 'direct') !== 'direct') errors.push(`rules: ${t}: unit_source only for direct rules`);
    if (r.sources !== undefined && r.type !== 'formula') errors.push(`rules: ${t}: sources (further source fields) only for type formula`);
    if (r.type === 'routine' && r.source === undefined) errors.push(`rules: ${t}: a routine needs its source field (source)`);
  }
}

/** BW stores constants formatted: "100" comes back as "100.00", "EU" as "EU " (field length). */
export function sameConstant(stored: string | undefined, wanted: string | undefined): boolean {
  const a = (stored ?? '').trim();
  const b = (wanted ?? '').trim();
  if (a === b) return true;
  const num = /^[-+]?\d+(?:[.,]\d+)?$/;
  return num.test(a) && num.test(b) && Number(a.replace(',', '.')) === Number(b.replace(',', '.'));
}

/** Is the existing rule for this target already what the spec asks for? */
function ruleMatches(current: TrfnRule | undefined, aggregation: string | undefined, r: RuleSpec): boolean {
  if (r.aggregation && r.aggregation !== aggregation) return false;
  if (!current) return false;
  const norm = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  switch (r.type) {
    case 'direct': {
      const direct = current.kind === 'direct' || /conversion/.test(current.kind);
      return direct && (r.unitSource ? current.sources[0] === r.source : current.sources.join(',') === r.source);
    }
    case 'constant':
      return current.kind === 'constant' && sameConstant(current.detail?.replace(/^"|"$/g, ''), r.value);
    case 'formula':
      return current.kind === 'formula' && norm(current.detail) === norm(r.formula);
    case 'no_update':
      return current.kind === 'no update';
    case 'lookup':
      return /lookup/.test(current.kind) && current.sources.includes(r.source ?? '') && new RegExp(`\\b${r.lookup?.name ?? '#'}\\b`).test(current.raw ?? '');
    case 'routine':
      return current.kind === 'routine' && current.sources.includes(r.source ?? '');
  }
}

/** Direct rule with conversion or unit source: the extra settings must show in the rule XML. */
function extrasMatch(current: TrfnRule | undefined, r: RuleSpec): boolean {
  if (!current) return false;
  if (r.conversion && !new RegExp(`\\b${r.conversion.name}\\b`).test(current.raw ?? '')) return false;
  if (r.unitSource && !current.sources.includes(r.unitSource)) return false;
  return true;
}

/** A routine rule is saved without code; BW activates it once the code is written. */
function routineHint(rules: RuleSpec[]): string | undefined {
  const targets = rules.filter((r) => r.type === 'routine').map((r) => r.target);
  if (targets.length === 0) return undefined;
  return `The routine for ${targets.join(', ')} has no code yet: write it with the ABAP tools (bw_read part="rules" names class and method), then call bw_activate.`;
}

/** Write the rules one by one; returns the lock handle of the last save, or undefined. */
async function applyRules(ctx: { client: BwClient; transport?: string }, name: string, rules: RuleSpec[], xml?: string): Promise<{ handle?: string; notes: string[] }> {
  const model = xml ? parseTrfn(name, xml) : undefined;
  const aggr = xml ? targetAggregations(xml) : new Map<string, string>();
  const notes: string[] = [];
  let handle: string | undefined;
  for (const r of rules) {
    const current = model?.rules.find((x) => x.targets.includes(r.target));
    if (model && ruleMatches(current, aggr.get(r.target), r) && extrasMatch(current, r)) continue;
    const further = r.type === 'formula' ? r.sources : undefined;
    const write = async () =>
      JSON.parse(
        await bwUpdateTransformation(
          ctx.client, name, ['direct', 'lookup', 'routine'].includes(r.type) ? r.source : undefined, r.target, r.type, r.formula, r.value,
          r.lookup?.name, r.lookup?.type, ctx.transport, further?.length ? further : undefined, r.unitSource, r.conversion, r.aggregation,
        ),
      ) as { success?: boolean; message?: string; lock_handle?: string };
    let res = await write();
    if (res.success === false && r.type !== 'no_update' && /no_update"? first/.test(res.message ?? '')) {
      // BW cannot turn some step types into others directly: reset the rule, then write it again.
      const reset = JSON.parse(await bwUpdateTransformation(ctx.client, name, undefined, r.target, 'no_update', undefined, undefined, undefined, undefined, ctx.transport)) as { success?: boolean; message?: string };
      if (reset.success === false) throw new ToolError('validation', `Rule for ${r.target}: ${reset.message ?? 'reset refused'}`, 'bw_read(type="TRFN", part="rules") shows the current rule.');
      res = await write();
    }
    if (res.success === false) throw new ToolError('validation', `Rule for ${r.target}: ${res.message ?? 'refused'}`, 'bw_read(type="TRFN", part="fields") lists the source and target fields.');
    handle = res.lock_handle ?? handle;
    notes.push(`${r.target} ${r.type.replace('_', ' ')}`);
  }
  return { handle, notes };
}

/** The transformation from source to target, found through the target's where-used list. */
export async function findTrfn(client: BwClient, source: FlowEnd, target: FlowEnd): Promise<string | undefined> {
  const hits = await xref(client, target.type, target.name, target.sourceSystem);
  return hits.find((h) => h.type === 'TRFN' && sameTitle(h.title, trfnTitle(source, target)))?.name;
}

function isTechnicalName(name: string): boolean {
  return /^[A-Z0-9]{20,}$/.test(name);
}

export const trfnAdapter: ObjectAdapter = {
  ...trfnReader,
  activationType: 'trfn',

  describe(action) {
    return (
      action === 'create'
        ? [
            'TRFN create spec (omit name: BW generates it; the result line reports it)',
            '  source   {type, name, source_system}   ADSO | HCPR | RSDS | TRCS | IOBJ   (required)',
            '           source_system only for RSDS',
            '  target   {type, name}                  ADSO | TRCS | IOBJ                 (required)',
            '           part for an InfoObject (source or target): texts | attributes | hierarchy',
            '  copy_from  technical name of a transformation whose rules are copied',
            '  rules    exceptions only: BW proposes a direct rule for every target field with a',
            '           same-named source field; target fields without one get "no update".',
            '    target       target field                                            (required)',
            '    type         direct (default) | constant | formula | no_update | lookup | routine',
            '    source       source field for direct (default = target), lookup or routine',
            '    value        for constant',
            '    formula      for formula, BW formula syntax, e.g. "PRICE * 2"',
            '    aggregation  for key figures: SUM | MOV | MIN | MAX | NOP',
            '    lookup       for lookup: {type: ADSO | IOBJ, name}; source = the key field',
            '    conversion   for direct: {type: currency | unit, name of the translation type,',
            '                 source_field holding the source currency/unit}',
            '    unit_source  for direct: field with the currency/unit of a key figure',
            '    sources      for formula: further source fields the formula reads',
            'A routine rule is saved without code: write it with the ABAP tools, then bw_activate.',
            'A create of a transformation that already exists between source and target updates its',
            'rules instead. Routines and the runtime follow with update.',
            'Examples',
            '  {"action":"create","type":"TRFN","spec":{"source":{"type":"ADSO","name":"ZSALES01"},"target":{"type":"ADSO","name":"ZSALES02"}}}',
            '  {"action":"create","type":"TRFN","spec":{"source":{"type":"RSDS","name":"ZDS_SALES","source_system":"SELF"},"target":{"type":"ADSO","name":"ZSALES01"},"rules":[{"target":"ZREGION","type":"constant","value":"EU"},{"target":"ZAMOUNT","source":"NETWR"}]}}',
          ]
        : [
            'TRFN update spec (name = the technical name, or omit name and use action create)',
            '  rules     list as in create; only the listed target fields change',
            '  runtime   hana | abap: switched, activated and checked in the active version',
            '  routines  {start, end, expert}: each "delete" or {code, fields, exclude_fields};',
            '            {} creates the routine without code (start and end pass the records on;',
            '            an expert routine under HANA needs code); code = the complete',
            '            METHOD … ENDMETHOD. block (AMDP for HANA runtime, ABAP otherwise);',
            '            fields / exclude_fields = the target fields the end routine processes',
            '            (key and technical fields always stay in). An expert routine replaces',
            '            the rules and the end routine; deleting it leaves the fields without rule.',
            'Each part is activated before the next.',
            'Example',
            '  {"action":"update","type":"TRFN","name":"0OQM91GD2ILQ06MWUTTS2J8HSVT095L0","spec":{"rules":[{"target":"ZAMOUNT","aggregation":"MOV"}]}}',
          ]
    ).join('\n');
  },

  check(action: WriteAction, _name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (action === 'update') errors.push(...routineErrors(s));
    if (action === 'create') {
      const src = flowEnd(s.source);
      const tgt = flowEnd(s.target);
      if (src.type && !SOURCE_TYPES.includes(src.type)) errors.push(`source.type: ${src.type} is not allowed; allowed: ${SOURCE_TYPES.join(', ')}`);
      if (tgt.type && !TARGET_TYPES.includes(tgt.type)) errors.push(`target.type: ${tgt.type} is not allowed; allowed: ${TARGET_TYPES.join(', ')}`);
      if (src.type === 'RSDS' && !src.sourceSystem) errors.push('source.source_system: required for a DataSource');
      if (src.type !== 'RSDS' && src.sourceSystem) errors.push('source.source_system: only for a DataSource');
      for (const [k, e] of [['source', s.source], ['target', s.target]] as const) {
        const part = (e as JsonObject | undefined)?.part;
        if (part !== undefined && flowEnd(e).type !== 'IOBJ') errors.push(`${k}.part: only for an InfoObject`);
      }
    }
    checkRules(s.rules, errors);
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action !== 'create' || !spec) return [];
    return [flowEnd(spec.source), flowEnd(spec.target)].map((e) => ({ type: e.type, name: e.name }) as ObjectRef);
  },

  targetInfoArea() {
    return undefined;
  },

  identity(spec) {
    return flowIdentity(flowEnd(spec.source), flowEnd(spec.target));
  },

  boundary(spec) {
    const t = flowEnd(spec.target);
    return [{ type: t.type, name: t.name } as ObjectRef];
  },

  async locate(client: BwClient, name: string): Promise<Location> {
    let real = name;
    if (!isTechnicalName(name)) {
      const ends = parseIdentity(name);
      if (!ends) return { exists: false };
      const found = await findTrfn(client, ends.source, ends.target);
      if (!found) return { exists: false };
      real = found;
    }
    try {
      return { ...locationFromXml((await readDoc(real)).xml), name: real };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async create(_name, spec, ctx) {
    const src = flowEnd(spec.source);
    const tgt = flowEnd(spec.target);
    const part = (end: unknown) => PART_SUBTYPE[String((end as JsonObject | undefined)?.part ?? '')];
    const res = JSON.parse(
      await bwCreateTransformation(ctx.client, {
        source_object_type: src.type,
        source_object_name: src.name,
        source_system: src.sourceSystem,
        target_object_type: tgt.type,
        target_object_name: tgt.name,
        source_object_subtype: part(spec.source),
        target_object_subtype: part(spec.target),
        copy_from_transformation: typeof spec.copy_from === 'string' ? spec.copy_from.toUpperCase() : undefined,
        package: ctx.package,
        transport: ctx.transport,
      }),
    ) as { transformation_name: string };
    const name = res.transformation_name.toUpperCase();
    const rules = rulesOf(spec);
    const applied = rules.length > 0 ? await applyRules(ctx, name, rules, (await readDoc(name)).xml) : { handle: undefined, notes: [] as string[] };
    const handle = applied.handle ?? (await ctx.client.lock('trfn', name.toLowerCase()));
    const copied = typeof spec.copy_from === 'string' ? [`copied from TRFN ${spec.copy_from.toUpperCase()}`] : [];
    return { status: 'created', name, activation: { lockHandle: handle }, notes: [...copied, ...applied.notes], activationHint: routineHint(rules) };
  },

  async update(name, spec, ctx) {
    const rules = rulesOf(spec);
    const more = spec.routines !== undefined || spec.runtime !== undefined;
    if (rules.length === 0 && !more) return { status: 'unchanged' };
    const { xml } = await readDoc(name);
    let notes: string[] = [];
    if (rules.length) {
      const applied = await applyRules(ctx, name, rules, xml);
      if (applied.handle !== undefined && !more) return { status: 'changed', activation: { lockHandle: applied.handle }, notes: applied.notes, activationHint: routineHint(rules) };
      if (applied.handle !== undefined) await activateNow(ctx, name, applied.handle, 'rules');
      notes = applied.notes;
    }
    if (!more) return { status: 'unchanged' };
    const now = (await readDoc(name)).xml;
    const current = parseTrfn(name, now);
    notes.push(...(await applyRoutines(ctx, name, spec, current, now)));
    if (typeof spec.runtime === 'string' && (spec.runtime === 'hana') !== (current.hana === true)) {
      legacyAnswer(await bwSetTransformationRuntime(ctx.client, name, spec.runtime as 'hana' | 'abap', ctx.transport), 'runtime');
      notes.push(`${spec.runtime === 'hana' ? 'HANA' : 'ABAP'} runtime`);
    }
    return notes.length ? { status: 'changed', activated: true, notes } : { status: 'unchanged' };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'trfn', name);
    return { status: 'deleted' };
  },
};
