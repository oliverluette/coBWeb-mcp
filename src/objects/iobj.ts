/**
 * InfoObject (IOBJ): characteristics and key figures.
 *
 * The spec speaks the modeler's language (AMOUNT, currency); the translation into BW internals
 * (objectSpecificDataType CURR, keyfigureType AMO) happens in the legacy write path, which carries
 * the fix of patch 0001 (amount key figures were created as AMT and could not be activated).
 */
import { MEDIA_TYPES, bwSeg, freshRead, type BwClient } from '../bw/client.js';
import { validateArgs } from '../format/validate.js';
import { ToolError } from '../format/errors.js';
import { bwCreateInfoObject, bwUpdateInfoObject, kyfTypeFor, type AttributeDef } from '../legacy/infoobject.js';
import { bwDelete } from '../legacy/delete.js';
import { hierarchyList } from './hierarchy.js';
import type { JsonObject } from '../catalog/tools.js';
import {
  documentStatus,
  isNotFound,
  locationFromXml,
  statusText,
  xmlDecode,
  type ObjectAdapter,
  type ObjectRef,
  type Spec,
  type WriteAction,
} from './adapter.js';

/** Key figure data types: modeler names and the BW codes they stand for (both accepted). */
const KYF_TYPES: Record<string, string> = {
  AMOUNT: 'CURR',
  QUANTITY: 'QUAN',
  NUMBER: 'DEC',
  INTEGER: 'INT4',
  DATE: 'DATS',
  TIME: 'TIMS',
  CURR: 'CURR',
  QUAN: 'QUAN',
  DEC: 'DEC',
  FLTP: 'FLTP',
  INT4: 'INT4',
  INT8: 'INT8',
  DATS: 'DATS',
  TIMS: 'TIMS',
};
const CHA_TYPES: Record<string, string> = { CHAR: 'CHAR', NUMC: 'NUMC', DATE: 'DATS', TIME: 'TIMS', DATS: 'DATS', TIMS: 'TIMS' };
const KINDS: Record<string, 'CHA' | 'KYF'> = { characteristic: 'CHA', key_figure: 'KYF', CHA: 'CHA', KYF: 'KYF' };

const PROPS: JsonObject = {
  kind: { type: 'string', enum: Object.keys(KINDS) },
  description: { type: 'string' },
  info_area: { type: 'string' },
  data_type: { type: 'string', enum: [...new Set([...Object.keys(CHA_TYPES), ...Object.keys(KYF_TYPES)])] },
  length: { type: 'integer', minimum: 1, maximum: 250 },
  conversion_routine: { type: 'string' },
  master_data: { type: 'boolean' },
  texts: { type: 'boolean' },
  lower_case: { type: 'boolean' },
  hierarchies: { type: 'boolean' },
  compound: { type: 'array', items: { type: 'string' } },
  currency: { type: 'string' },
  unit: { type: 'string' },
  aggregation: { type: 'string', enum: ['SUM', 'MAX', 'MIN'] },
  // InfoObject names (display attributes) or {name, navigation, time_dependent}; checked by checkAttributes.
  attributes: { type: 'array', items: {} },
};
const ATTRIBUTE: JsonObject = {
  type: 'object',
  properties: { name: { type: 'string' }, navigation: { type: 'boolean' }, time_dependent: { type: 'boolean' } },
  required: ['name'],
  additionalProperties: false,
};

export interface IobjAttribute {
  name: string;
  navigation: boolean;
  timeDependent: boolean;
}

function attributesOf(v: unknown): IobjAttribute[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) =>
    typeof a === 'string'
      ? { name: a.trim().toUpperCase(), navigation: false, timeDependent: false }
      : { name: String((a as JsonObject).name).trim().toUpperCase(), navigation: (a as JsonObject).navigation === true, timeDependent: (a as JsonObject).time_dependent === true },
  );
}

function checkAttributes(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) return;
  const seen = new Set<string>();
  v.forEach((a, i) => {
    if (typeof a !== 'string') {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return void errors.push(`attributes[${i}]: an InfoObject name or {name, navigation, time_dependent}`);
      for (const m of validateArgs(ATTRIBUTE, a as JsonObject).errors) errors.push(`attributes[${i}].${m}`);
    }
  });
  for (const a of attributesOf(v)) {
    if (seen.has(a.name)) errors.push(`attributes: ${a.name} is listed twice`);
    seen.add(a.name);
  }
}

const attributeKey = (list: IobjAttribute[]) =>
  list
    .map((a) => `${a.name}|${a.navigation ? 'NAV' : 'DIS'}|${a.timeDependent}`)
    .sort()
    .join(',');
const CREATE: JsonObject = { type: 'object', properties: PROPS, required: ['kind', 'description', 'info_area'], additionalProperties: false };
const UPDATE: JsonObject = { type: 'object', properties: PROPS, additionalProperties: false };

const CHA_ONLY = ['length', 'conversion_routine', 'master_data', 'texts', 'lower_case', 'hierarchies', 'compound', 'attributes'];
const KYF_ONLY = ['currency', 'unit', 'aggregation'];

export interface IobjModel {
  name: string;
  kind: 'CHA' | 'KYF';
  description: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  keyfigureType?: string;
  currency?: string;
  unit?: string;
  aggregation?: string;
  conversion?: string;
  lowerCase: boolean;
  masterData: boolean;
  texts: boolean;
  hierarchies: boolean;
  compound: string[];
  attributes: string[];
  attributeDetails: IobjAttribute[];
  infoArea?: string;
  package?: string;
  status?: string;
}

export function parseIobj(name: string, xml: string): IobjModel {
  const el = (tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
  const num = (tag: string) => (el(tag) !== undefined ? Number(el(tag)) : undefined);
  const loc = locationFromXml(xml);
  return {
    name: name.toUpperCase(),
    kind: el('infoObjectType') === 'KYF' ? 'KYF' : 'CHA',
    description: xmlDecode(el('longDescription') ?? el('shortDescription') ?? ''),
    dataType: el('dataType') ?? xml.match(/\bobjectSpecificDataType="([^"]*)"/)?.[1] ?? '',
    length: num('length'),
    precision: num('precision'),
    scale: num('scale'),
    keyfigureType: xml.match(/\bkeyfigureType="([^"]*)"/)?.[1],
    currency: el('fixedCurrency') || undefined,
    unit: el('fixedUnit') || undefined,
    aggregation: el('aggregationType') || undefined,
    conversion: xml.match(/<\w+:infoObject\b[^>]*\bconversionRoutine="([^"]*)"/)?.[1] || undefined,
    lowerCase: /\bwithLowerCaseLetters="true"/.test(xml),
    masterData: /<masterDataTable\b[^>]*\bstatus="A"/.test(xml),
    texts: /<textTable\b[^>]*\bstatus="A"/.test(xml),
    hierarchies: /<hierarchyProperties\b[^>]*\bwithHierarchies="true"/.test(xml),
    compound: [...xml.matchAll(/<compoundParent\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]),
    attributes: [...xml.matchAll(/<attribute\w*\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]),
    attributeDetails: [...xml.matchAll(/<attributeN\b[^>]*>/g)].map((m) => ({
      name: m[0].match(/\bname="([^"]+)"/)?.[1] ?? '',
      navigation: /\btype="NAV"/.test(m[0]),
      timeDependent: /\btimeDependent="true"/.test(m[0]),
    })),
    infoArea: loc.infoArea,
    package: loc.package,
    status: documentStatus(xml),
  };
}

function typeLine(m: IobjModel): string {
  if (m.kind === 'KYF') {
    const size = m.precision !== undefined ? ` ${m.precision}${m.scale !== undefined ? `,${m.scale}` : ''}` : '';
    const parts = [`${m.dataType}${size}${m.keyfigureType ? ` (keyfigureType ${m.keyfigureType})` : ''}`];
    if (m.currency) parts.push(`fixed currency ${m.currency}`);
    if (m.unit) parts.push(`fixed unit ${m.unit}`);
    if (m.aggregation) parts.push(`aggregation ${m.aggregation}`);
    return parts.join(', ');
  }
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return [
    `${m.dataType}${m.length !== undefined ? ` ${m.length}` : ''}`,
    `conversion ${m.conversion || 'none'}`,
    `master data ${yn(m.masterData)}`,
    `texts ${yn(m.texts)}`,
    `lower case ${yn(m.lowerCase)}`,
    ...(m.hierarchies ? ['hierarchies yes'] : []),
  ].join(', ');
}

export function summarizeIobj(m: IobjModel, detail: 'summary' | 'full', part?: string): string {
  const head = `IOBJ ${m.name} "${m.description}" · ${statusText(m.status)} · ${m.kind === 'KYF' ? 'key figure' : 'characteristic'} · InfoArea ${m.infoArea ?? '?'} · package ${m.package ?? '?'}`;
  const lines = [head, `  ${typeLine(m)}`];
  if (m.compound.length > 0) lines.push(`  compound: ${m.compound.join(', ')}`);
  if (detail === 'full' || part === 'attributes') {
    const list = m.attributeDetails.length > 0 ? m.attributeDetails.map((a) => `${a.name}${a.navigation ? ' (navigation)' : ''}${a.timeDependent ? ' (time-dependent)' : ''}`) : m.attributes;
    lines.push(`  attributes: ${list.length > 0 ? list.join(', ') : 'none'}`);
  }
  return lines.join('\n');
}

async function readXml(name: string): Promise<string> {
  return (await freshRead(`/sap/bw/modeling/iobj/${bwSeg(name.toLowerCase())}/m`, MEDIA_TYPES['iobj'])).body;
}

function toLegacyAttribute(a: IobjAttribute): AttributeDef {
  return { name: a.name, type: a.navigation ? 'NAV' : 'DIS', ...(a.timeDependent ? { timeDependent: true } : {}) };
}

function kindOf(spec: Spec | undefined): 'CHA' | 'KYF' | undefined {
  return typeof spec?.kind === 'string' ? KINDS[spec.kind] : undefined;
}

export const iobjAdapter: ObjectAdapter = {
  type: 'IOBJ',
  label: 'InfoObject',
  activationType: 'iobj',

  describe(action) {
    const lines = [
      `IOBJ ${action} spec`,
      `  kind          characteristic | key_figure${action === 'create' ? '              (required)' : ''}`,
      `  description   text, max 60${action === 'create' ? '                           (required)' : ''}`,
      `  info_area     InfoArea name${action === 'create' ? '                          (required)' : ''}`,
      'characteristic:',
      '  data_type     CHAR (default) | NUMC | DATE | TIME',
      '  length        1..250, default 10 (not for DATE/TIME)',
      '  master_data, texts, lower_case, hierarchies   true | false (default false);',
      '                hierarchies: the characteristic may have hierarchies (type HIER)',
      '  conversion_routine   default ALPHA for CHAR/NUMC',
      '  compound      list of characteristics this one is compounded to',
      '  attributes    characteristics as attributes: names (display) or {name, navigation, time_dependent};',
      '                the complete list, [] removes all',
      'key_figure:',
      '  data_type     AMOUNT | QUANTITY | NUMBER (default) | INTEGER | DATE | TIME',
      '  currency      ISO code, e.g. EUR (required for AMOUNT)',
      '  unit          e.g. KG (required for QUANTITY)',
      '  aggregation   SUM (default) | MAX | MIN',
      'Name: 3–9 characters, starting with a letter. BW codes (CURR, QUAN, DEC, INT4) are accepted as data_type too.',
    ];
    if (action === 'update') {
      lines.push('update can change description, currency, unit, lower_case, hierarchies and attributes. kind, data_type and length of an existing InfoObject cannot change; delete and recreate it while no provider uses it. An update activates the InfoObject.');
    }
    lines.push(
      'Examples',
      '  {"action":"create","type":"IOBJ","name":"ZCUSTOMER","spec":{"kind":"characteristic","description":"Customer","info_area":"ZSALES","data_type":"CHAR","length":10}}',
      '  {"action":"create","type":"IOBJ","name":"ZAMOUNT","spec":{"kind":"key_figure","description":"Amount","info_area":"ZSALES","data_type":"AMOUNT","currency":"EUR"}}',
    );
    return lines.join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (action === 'create' && !/^[A-Z][A-Z0-9_]{2,8}$/i.test(name)) errors.push('name: 3–9 characters A–Z, 0–9, _, starting with a letter');
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    const kind = kindOf(s);
    const dt = typeof s.data_type === 'string' ? s.data_type.toUpperCase() : undefined;
    if (kind === 'CHA') {
      for (const k of KYF_ONLY) if (s[k] !== undefined) errors.push(`${k}: only for key figures`);
      if (dt && !CHA_TYPES[dt]) errors.push(`data_type: ${dt} is not a characteristic type; use CHAR, NUMC, DATE or TIME`);
      if ((dt === 'DATE' || dt === 'DATS' || dt === 'TIME' || dt === 'TIMS') && s.length !== undefined) errors.push('length: not for DATE/TIME');
    }
    if (kind === 'KYF') {
      for (const k of CHA_ONLY) if (s[k] !== undefined) errors.push(`${k}: only for characteristics`);
      const bwType = dt ? KYF_TYPES[dt] : 'DEC';
      if (dt && !bwType) errors.push(`data_type: ${dt} is not a key figure type; use AMOUNT, QUANTITY, NUMBER, INTEGER, DATE or TIME`);
      if (bwType === 'CURR' && action === 'create' && s.currency === undefined) errors.push('currency: required for an AMOUNT key figure, e.g. "EUR"');
      if (bwType === 'QUAN' && action === 'create' && s.unit === undefined) errors.push('unit: required for a QUANTITY key figure, e.g. "KG"');
      if (s.currency !== undefined && bwType !== 'CURR') errors.push('currency: only for AMOUNT key figures');
      if (s.unit !== undefined && bwType !== 'QUAN') errors.push('unit: only for QUANTITY key figures');
    }
    checkAttributes(s.attributes, errors);
    if (typeof s.currency === 'string' && !/^[A-Z]{3}$/i.test(s.currency)) {
      errors.push('currency: a 3-letter ISO code such as EUR; a currency InfoObject (0CURRENCY) is not supported yet');
    }
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action === 'delete' || !spec) return [];
    const refs: ObjectRef[] = [];
    if (typeof spec.info_area === 'string') refs.push({ type: 'AREA', name: spec.info_area.toUpperCase() });
    if (Array.isArray(spec.compound)) for (const c of spec.compound) refs.push({ type: 'IOBJ', name: String(c).toUpperCase() });
    for (const a of attributesOf(spec.attributes)) refs.push({ type: 'IOBJ', name: a.name });
    return refs;
  },

  targetInfoArea(_name, spec) {
    return typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
  },

  async locate(_client: BwClient, name: string) {
    try {
      return locationFromXml(await readXml(name));
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async read(_client, name, { detail, part }) {
    const xml = await readXml(name);
    if (detail === 'raw') return xml;
    const m = parseIobj(name, xml);
    if (part?.toLowerCase() === 'hierarchies') {
      const head = summarizeIobj(m, 'summary').split('\n')[0];
      if (m.kind === 'KYF') return `${head}\nA key figure has no hierarchies.`;
      return `${head}\n${await hierarchyList(_client, name)}`;
    }
    return summarizeIobj(m, detail, part);
  },

  async create(name, spec, ctx) {
    const kind = kindOf(spec) ?? 'CHA';
    const dt = typeof spec.data_type === 'string' ? spec.data_type.toUpperCase() : undefined;
    if (kind === 'KYF') {
      const ost = dt ? KYF_TYPES[dt] : 'DEC';
      const res = JSON.parse(
        await bwCreateInfoObject(ctx.client, {
          infoobject_type: 'KYF',
          name,
          info_area: String(spec.info_area),
          description: String(spec.description),
          object_specific_data_type: ost,
          aggregation_type: typeof spec.aggregation === 'string' ? spec.aggregation : undefined,
          fixed_currency: typeof spec.currency === 'string' ? spec.currency.toUpperCase() : undefined,
          fixed_unit: typeof spec.unit === 'string' ? spec.unit.toUpperCase() : undefined,
          package: ctx.package,
          transport: ctx.transport,
        }),
      ) as { lockHandle?: string };
      const notes = [`key figure ${kyfTypeFor(ost).keyfigureType}`];
      if (spec.currency) notes.push(`fixed currency ${String(spec.currency).toUpperCase()}`);
      if (spec.unit) notes.push(`fixed unit ${String(spec.unit).toUpperCase()}`);
      return { status: 'created', activation: { lockHandle: res.lockHandle ?? '' }, notes };
    }
    const chaType = dt ? CHA_TYPES[dt] : 'CHAR';
    const length = chaType === 'DATS' ? 8 : chaType === 'TIMS' ? 6 : typeof spec.length === 'number' ? spec.length : 10;
    const res = JSON.parse(
      await bwCreateInfoObject(ctx.client, {
        infoobject_type: 'CHA',
        name,
        info_area: String(spec.info_area),
        description: String(spec.description),
        data_type: chaType,
        length,
        conversion_routine: typeof spec.conversion_routine === 'string' ? spec.conversion_routine : undefined,
        with_master_data: spec.master_data === true,
        with_texts: spec.texts === true,
        with_hierarchies: spec.hierarchies === true,
        lower_case: typeof spec.lower_case === 'boolean' ? spec.lower_case : undefined,
        compound_infoobjects: Array.isArray(spec.compound) ? spec.compound.map(String) : undefined,
        package: ctx.package,
        transport: ctx.transport,
      }),
    ) as { lockHandle?: string };
    const attributes = attributesOf(spec.attributes);
    if (attributes.length > 0) {
      // The attribute list is written on the saved characteristic; that update also activates it.
      // The create lock has to go first: the update takes its own lock and activates in another session.
      await ctx.client.unlock('iobj', name.toLowerCase()).catch(() => undefined);
      await bwUpdateInfoObject(ctx.client, { name, attributes: attributes.map(toLegacyAttribute), transport: ctx.transport });
      return { status: 'created', activated: true, notes: [`${chaType} ${length}`, `${attributes.length} attributes`] };
    }
    return { status: 'created', activation: { lockHandle: res.lockHandle ?? '' }, notes: [`${chaType} ${length}`] };
  },

  async update(name, spec, ctx) {
    const current = parseIobj(name, await readXml(name));
    const kind = kindOf(spec);
    const dt = typeof spec.data_type === 'string' ? spec.data_type.toUpperCase() : undefined;
    const wantType = dt ? (current.kind === 'KYF' ? KYF_TYPES[dt] : CHA_TYPES[dt]) : undefined;
    const fixed: string[] = [];
    if (kind && kind !== current.kind) fixed.push(`kind (is ${current.kind === 'KYF' ? 'key_figure' : 'characteristic'})`);
    if (wantType && wantType !== current.dataType) fixed.push(`data_type (is ${current.dataType})`);
    if (typeof spec.length === 'number' && spec.length !== current.length) fixed.push(`length (is ${current.length})`);
    if (fixed.length > 0) {
      throw new ToolError(
        'validation',
        `${name.toUpperCase()}: ${fixed.join(', ')} cannot change on an existing InfoObject.`,
        'Delete the InfoObject and create it again (only possible while no provider uses it), or choose a new name.',
      );
    }
    const args: Parameters<typeof bwUpdateInfoObject>[1] = { name, transport: ctx.transport };
    let changed = false;
    if (typeof spec.description === 'string' && spec.description !== current.description) {
      args.description = spec.description;
      changed = true;
    }
    if (typeof spec.currency === 'string' && spec.currency.toUpperCase() !== current.currency) {
      args.fixed_currency = spec.currency.toUpperCase();
      changed = true;
    }
    if (typeof spec.unit === 'string' && spec.unit.toUpperCase() !== current.unit) {
      args.fixed_unit = spec.unit.toUpperCase();
      changed = true;
    }
    if (typeof spec.lower_case === 'boolean' && spec.lower_case !== current.lowerCase) {
      args.lower_case = spec.lower_case;
      changed = true;
    }
    if (typeof spec.hierarchies === 'boolean' && spec.hierarchies !== current.hierarchies) {
      args.hierarchies = spec.hierarchies;
      changed = true;
    }
    if (spec.attributes !== undefined && attributeKey(attributesOf(spec.attributes)) !== attributeKey(current.attributeDetails)) {
      args.attributes = attributesOf(spec.attributes).map(toLegacyAttribute);
      changed = true;
    }
    // Properties that cannot be changed yet are fine as long as they match (a create of an
    // existing object arrives here with the full spec).
    const same = (a: unknown, b: unknown) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
    const differs = [
      typeof spec.info_area === 'string' && !same(spec.info_area, current.infoArea) ? `info_area (is ${current.infoArea})` : '',
      typeof spec.master_data === 'boolean' && spec.master_data !== current.masterData ? 'master_data' : '',
      typeof spec.texts === 'boolean' && spec.texts !== current.texts ? 'texts' : '',
      typeof spec.conversion_routine === 'string' && !same(spec.conversion_routine, current.conversion) ? `conversion_routine (is ${current.conversion ?? 'none'})` : '',
      typeof spec.aggregation === 'string' && !same(spec.aggregation, current.aggregation) ? `aggregation (is ${current.aggregation})` : '',
      Array.isArray(spec.compound) && spec.compound.map((c) => String(c).toUpperCase()).join(',') !== current.compound.join(',') ? 'compound' : '',
    ].filter(Boolean);
    if (differs.length > 0) {
      throw new ToolError(
        'not_implemented',
        `${name.toUpperCase()}: changing ${differs.join(', ')} of an existing InfoObject is not supported yet.`,
        'Leave these fields out, or give their current values.',
      );
    }
    if (!changed) return { status: 'unchanged' };
    await bwUpdateInfoObject(ctx.client, args);
    return { status: 'changed', activated: true };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'iobj', name);
    return { status: 'deleted' };
  },
};
