/**
 * InfoSource (TRCS): a field structure between two transformations.
 *
 * A create takes InfoObject names (like an ADSO) and/or copies the structure of an existing
 * object (copy_from). The InfoObject properties (data type, length, aggregation) are read from
 * BW, so the caller never spells them out.
 */
import { MEDIA_TYPES, bwSeg, createClientFromEnv, freshRead, stripInfoAreaSentinel, type BwClient } from '../bw/client.js';
import { validateArgs } from '../format/validate.js';
import { ToolError } from '../format/errors.js';
import { bwCreateInfosource, bwUpdateInfosource, type InfosourceField } from '../legacy/infosource.js';
import { bwDelete } from '../legacy/delete.js';
import type { JsonObject } from '../catalog/tools.js';
import { parseIobj } from './iobj.js';
import {
  documentStatus,
  isNotFound,
  locationFromXml,
  statusText,
  xmlDecode,
  xmlEscape,
  type ObjectAdapter,
  type ObjectRef,
  type Spec,
  type WriteAction,
} from './adapter.js';

const TRCS_MEDIA = 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml';
const NAMES: JsonObject = { type: 'array', items: { type: 'string' } };
const COPY_FROM: JsonObject = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['ADSO', 'HCPR', 'RSDS', 'IOBJ'] },
    name: { type: 'string' },
    source_system: { type: 'string' },
  },
  required: ['type', 'name'],
  additionalProperties: false,
};
const CREATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    info_area: { type: 'string' },
    fields: { type: 'array', items: {} },
    keys: NAMES,
    copy_from: COPY_FROM,
  },
  required: ['description', 'info_area'],
  additionalProperties: false,
};
const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    info_area: { type: 'string' },
    fields: { type: 'array', items: {} },
    fields_add: { type: 'array', items: {} },
    fields_remove: NAMES,
    keys: NAMES,
  },
  additionalProperties: false,
};

const upper = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim().toUpperCase()) : []);

/** Field without InfoObject: name, type, length, label, aggregation. */
const LOCAL_FIELD: JsonObject = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: ['CHAR', 'NUMC', 'DATS', 'TIMS', 'CUKY', 'UNIT', 'LANG', 'INT4', 'INT8', 'DEC', 'FLTP'] },
    length: { type: 'integer', minimum: 1, maximum: 1333 },
    scale: { type: 'integer', minimum: 0, maximum: 30 },
    label: { type: 'string' },
    aggregation: { type: 'string', enum: ['SUM', 'MIN', 'MAX', 'NONE'] },
  },
  required: ['name', 'type'],
  additionalProperties: false,
};
const FIXED_LENGTH: Record<string, number> = { DATS: 8, TIMS: 6, CUKY: 5, UNIT: 3, LANG: 1, INT4: 10, INT8: 19, FLTP: 16 };
const NUMERIC = new Set(['INT4', 'INT8', 'DEC', 'FLTP']);

type FieldEntry = string | { name: string; type: string; length?: number; scale?: number; label?: string; aggregation?: string };

/** Field name of an entry: an InfoObject name or a field object. */
const entryName = (e: unknown): string => (typeof e === 'string' ? e : String((e as JsonObject)?.name ?? '')).trim().toUpperCase();

function entriesOf(v: unknown): FieldEntry[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === 'string' ? e.trim().toUpperCase() : ({ ...(e as object), name: entryName(e) } as FieldEntry)));
}

function checkEntries(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) return;
  v.forEach((e, i) => {
    if (typeof e === 'string') return;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${path}[${i}]: an InfoObject name or a field object {name, type, …}`);
      return;
    }
    const o = e as JsonObject;
    for (const m of validateArgs(LOCAL_FIELD, o).errors) errors.push(`${path}[${i}].${m}`);
    const type = String(o.type ?? '').toUpperCase();
    if (['CHAR', 'NUMC', 'DEC'].includes(type) && o.length === undefined) errors.push(`${path}[${i}].length: required for ${type}`);
    if (typeof o.name === 'string' && !/^[A-Z][A-Z0-9_]{0,15}$/i.test(o.name)) errors.push(`${path}[${i}].name: 1–16 characters A–Z, 0–9, _, starting with a letter`);
  });
}

export interface TrcsField {
  name: string;
  infoObject?: string;
  dataType: string;
  /** Length, or precision and scale ("17,2"). */
  size: string;
  label: string;
  aggregation?: string;
}

export interface TrcsModel {
  name: string;
  label: string;
  infoArea?: string;
  package?: string;
  status?: string;
  fields: TrcsField[];
  keys: string[];
}

export function parseTrcs(name: string, xml: string): TrcsModel {
  const keys = [...xml.matchAll(/<keyElement>#\/\/\/([^<]+)<\/keyElement>/g)].map((m) => m[1].toUpperCase());
  const fields: TrcsField[] = [];
  for (const m of xml.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)) {
    const [, attrs, body] = m;
    const a = (src: string, k: string) => src.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
    const inline = body.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
    const len = a(inline, 'length');
    const precision = a(inline, 'precision');
    const scale = a(inline, 'scale');
    const aggr = a(attrs, 'aggregationBehavior');
    fields.push({
      name: a(attrs, 'name') ?? '',
      infoObject: a(attrs, 'infoObjectName') || undefined,
      dataType: a(inline, 'name') ?? '',
      // DEC keeps its digits in length and its decimals in precision.
      size:
        a(inline, 'name') === 'DEC' && len
          ? `${len}${precision && precision !== '0' ? `,${precision}` : ''}`
          : precision && precision !== '0' ? `${precision}${scale && scale !== '0' ? `,${scale}` : ''}` : len ?? '',
      label: xmlDecode(body.match(/<(?:endUserTexts|descriptions)\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
      aggregation: aggr && aggr !== 'NONE' ? aggr : undefined,
    });
  }
  const loc = locationFromXml(xml);
  const status = documentStatus(xml);
  const head = xml.slice(0, Math.max(0, xml.indexOf('<element')) || xml.length);
  return {
    name: name.toUpperCase(),
    label: xmlDecode(head.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
    infoArea: loc.infoArea ? stripInfoAreaSentinel(loc.infoArea) : undefined,
    package: loc.package,
    status,
    fields,
    keys,
  };
}

export function summarizeTrcs(m: TrcsModel, part?: string): string {
  const head = `TRCS ${m.name} "${m.label}" · ${statusText(m.status)} · InfoArea ${m.infoArea ?? '?'} · package ${m.package ?? '?'}`;
  if (part?.toLowerCase() === 'keys') return `${head}\nKey: ${m.keys.join(', ') || 'none'}`;
  const n = Math.max(4, ...m.fields.map((f) => f.name.length));
  const lines = [head, `Fields (${m.fields.length}, key marked *):`];
  for (const f of m.fields) {
    const type = `${f.dataType} ${f.size}`.trim();
    const tail = [f.aggregation, f.infoObject && f.infoObject !== f.name ? `IOBJ ${f.infoObject}` : f.infoObject ? '' : 'field'].filter(Boolean).join(' · ');
    lines.push(`  ${m.keys.includes(f.name.toUpperCase()) ? '*' : ' '} ${f.name.padEnd(n)}  ${type.padEnd(10)}  ${[f.label, tail].filter(Boolean).join('  ')}`.trimEnd());
  }
  return lines.join('\n');
}

async function readXml(name: string): Promise<string> {
  return (await freshRead(`/sap/bw/modeling/trcs/${bwSeg(name.toLowerCase())}/m`, TRCS_MEDIA)).body;
}

/**
 * InfoSource fields: for InfoObjects with their properties read from BW, for fields without
 * InfoObject as given.
 */
async function fieldsFor(entries: FieldEntry[], keys: string[], reader: () => Pick<BwClient, 'get'> = createClientFromEnv): Promise<InfosourceField[]> {
  // A fresh reader: InfoObjects written earlier in the same call may sit stale in the shared session.
  const r = reader();
  const out: InfosourceField[] = [];
  for (const entry of entries) {
    if (typeof entry === 'object') {
      const type = entry.type.toUpperCase();
      out.push({
        name: entry.name,
        type,
        length: FIXED_LENGTH[type] ?? entry.length ?? 0,
        ...(type === 'DEC' && entry.scale !== undefined ? { scale: entry.scale } : {}),
        label: xmlEscape(entry.label ?? entry.name),
        isKey: keys.includes(entry.name),
        aggregationBehavior: entry.aggregation ?? (NUMERIC.has(type) ? 'SUM' : 'NONE'),
      });
      continue;
    }
    const name = entry;
    const xml = (await r.get(`/sap/bw/modeling/iobj/${bwSeg(name.toLowerCase())}/m?forceCacheUpdate=true`, MEDIA_TYPES['iobj'])).body;
    const io = parseIobj(name, xml);
    out.push({
      name,
      infoObjectName: name,
      type: io.dataType,
      length: io.kind === 'KYF' ? io.precision ?? io.length ?? 17 : io.length ?? 0,
      label: xmlEscape(io.description || name),
      isKey: keys.includes(name),
      aggregationBehavior: io.kind === 'KYF' ? io.aggregation ?? 'SUM' : 'NONE',
    });
  }
  return out;
}

function handleOf(json: string): string {
  const r = JSON.parse(json) as { success?: boolean; message?: string; lock_handle?: string };
  if (r.success === false) throw new ToolError('backend', r.message ?? 'InfoSource update failed');
  return r.lock_handle ?? '';
}

export const trcsAdapter: ObjectAdapter = {
  type: 'TRCS',
  label: 'InfoSource',
  activationType: 'trcs',

  describe(action) {
    const lines =
      action === 'create'
        ? [
            'TRCS create spec (InfoSource: a field structure between two transformations)',
            'Not a transformation: the mapping from a source to a target is TRFN.',
            '  description   text, max 60                                  (required)',
            '  info_area     InfoArea name                                 (required)',
            '  fields        InfoObject names (type, length, aggregation come from the InfoObject) or',
            '                fields without InfoObject {name, type, length, scale, label, aggregation};',
            '                type CHAR NUMC DATS TIMS CUKY UNIT LANG INT4 INT8 DEC FLTP; CHAR/NUMC/DEC need length',
            '                (DEC: total digits, scale = decimal places)',
            '  keys          key fields, a subset of fields',
            '  copy_from     {type: ADSO|HCPR|RSDS|IOBJ, name, source_system}: take over the fields of an',
            '                existing object (source_system only for RSDS)',
            'Give fields, copy_from, or both (fields are added to the copied structure).',
            'Examples',
            '  {"action":"create","type":"TRCS","name":"ZSALES_IS","spec":{"description":"Sales","info_area":"ZSALES","fields":["ZCUSTOMER","ZAMOUNT"],"keys":["ZCUSTOMER"]}}',
            '  {"action":"create","type":"TRCS","name":"ZSALES_IS2","spec":{"description":"Sales","info_area":"ZSALES","copy_from":{"type":"ADSO","name":"ZSALES01"}}}',
          ]
        : [
            'TRCS update spec (only the named properties change)',
            '  description     text, max 60',
            '  fields          the complete field list (fields not listed are removed)',
            '  fields_add      fields to add, entries as in create',
            '  fields_remove   field names to remove',
            '  keys            key fields; may name added fields, existing keys cannot change yet',
            'Example',
            '  {"action":"update","type":"TRCS","name":"ZSALES_IS","spec":{"fields_add":["ZREGION"]}}',
          ];
    return lines.join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (action === 'create' && !/^[A-Z][A-Z0-9_]{1,29}$/i.test(name)) errors.push('name: 2–30 characters A–Z, 0–9, _, starting with a letter');
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    if (action === 'create' && s.fields === undefined && s.copy_from === undefined) errors.push('fields or copy_from: one is required');
    if (s.fields !== undefined && (s.fields_add !== undefined || s.fields_remove !== undefined)) errors.push('fields: give either fields or fields_add/fields_remove');
    checkEntries(s.fields, 'fields', errors);
    checkEntries(s.fields_add, 'fields_add', errors);
    const cf = s.copy_from as JsonObject | undefined;
    if (cf && cf.type === 'RSDS' && !cf.source_system) errors.push('copy_from.source_system: required for RSDS');
    const listed = new Set([...entriesOf(s.fields), ...entriesOf(s.fields_add)].map(entryName));
    if (action === 'create' && !cf) {
      for (const k of upper(s.keys)) if (!listed.has(k)) errors.push(`keys: ${k} is not in fields`);
    }
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action === 'delete' || !spec) return [];
    const refs: ObjectRef[] = [];
    if (typeof spec.info_area === 'string') refs.push({ type: 'AREA', name: spec.info_area.toUpperCase() });
    for (const e of [...entriesOf(spec.fields), ...entriesOf(spec.fields_add)]) if (typeof e === 'string') refs.push({ type: 'IOBJ', name: e });
    const cf = spec.copy_from as JsonObject | undefined;
    if (cf && (cf.type === 'ADSO' || cf.type === 'HCPR' || cf.type === 'IOBJ')) refs.push({ type: cf.type, name: String(cf.name).toUpperCase() });
    return refs;
  },

  targetInfoArea(_name, spec) {
    return typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
  },

  async locate(_client, name) {
    try {
      const loc = locationFromXml(await readXml(name));
      return { ...loc, infoArea: loc.infoArea ? stripInfoAreaSentinel(loc.infoArea) : undefined };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async read(_client, name, { detail, part }) {
    const xml = await readXml(name);
    if (detail === 'raw') return xml;
    return summarizeTrcs(parseTrcs(name, xml), part);
  },

  async create(name, spec, ctx) {
    const cf = spec.copy_from as JsonObject | undefined;
    await bwCreateInfosource(
      ctx.client,
      name,
      xmlEscape(String(spec.description)),
      String(spec.info_area),
      ctx.package,
      cf ? String(cf.name).toUpperCase() : undefined,
      cf ? String(cf.type) : undefined,
      undefined,
      cf?.source_system ? String(cf.source_system).toUpperCase() : undefined,
    );
    const entries = entriesOf(spec.fields);
    const notes = [cf ? `copied from ${cf.type} ${String(cf.name).toUpperCase()}` : '', entries.length ? `${entries.length} fields` : ''].filter(Boolean);
    if (entries.length === 0) {
      // Copied structure only: the create released its lock; take one for the activation.
      return { status: 'created', activation: { lockHandle: await ctx.client.lock('trcs', name) }, notes };
    }
    const handle = handleOf(await bwUpdateInfosource(ctx.client, name, undefined, await fieldsFor(entries, upper(spec.keys)), ctx.transport));
    return { status: 'created', activation: { lockHandle: handle }, notes };
  },

  async update(name, spec, ctx) {
    const current = parseTrcs(name, await readXml(name));
    const area = typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
    if (area && area !== current.infoArea) {
      throw new ToolError('not_implemented', `${name.toUpperCase()} is in InfoArea ${current.infoArea}; moving it is not supported yet.`, 'Leave info_area out or give the current one.');
    }
    const present = current.fields.map((f) => f.name.toUpperCase());
    const given = new Map([...entriesOf(spec.fields), ...entriesOf(spec.fields_add)].map((e) => [entryName(e), e]));
    const target =
      spec.fields !== undefined
        ? entriesOf(spec.fields).map(entryName)
        : [...present.filter((f) => !upper(spec.fields_remove).includes(f)), ...entriesOf(spec.fields_add).map(entryName).filter((f) => !present.includes(f))];
    const toAdd = target.filter((f) => !present.includes(f));
    const toRemove = present.filter((f) => !target.includes(f));
    if (spec.keys !== undefined) {
      const keys = upper(spec.keys);
      const kept = current.keys.filter((k) => target.includes(k));
      const existingWanted = keys.filter((k) => !toAdd.includes(k));
      if (existingWanted.join(',') !== kept.join(',')) {
        throw new ToolError(
          'not_implemented',
          `Changing the key of existing fields of ${name.toUpperCase()} is not supported yet (current key: ${current.keys.join(', ') || 'none'}).`,
          'Keys can be given for added fields only.',
        );
      }
    }
    const label = typeof spec.description === 'string' && spec.description !== current.label ? spec.description : undefined;
    if (!label && toAdd.length === 0 && toRemove.length === 0) return { status: 'unchanged' };
    const fields = toAdd.length > 0 ? await fieldsFor(toAdd.map((f) => given.get(f) ?? f), upper(spec.keys)) : undefined;
    const handle = handleOf(
      await bwUpdateInfosource(ctx.client, name, label !== undefined ? xmlEscape(label) : undefined, fields, ctx.transport, toRemove.length ? toRemove : undefined),
    );
    const notes = [label !== undefined ? 'description' : '', toAdd.length ? `added ${toAdd.join(', ')}` : '', toRemove.length ? `removed ${toRemove.join(', ')}` : ''].filter(Boolean);
    return { status: 'changed', activation: { lockHandle: handle }, notes };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'trcs', name);
    return { status: 'deleted' };
  },
};

export const __test = { fieldsFor };
