/**
 * DataStore object (advanced), ADSO.
 *
 * A create is complete in one call: the empty shell is created by the legacy create
 * path, then fields, keys and settings are written with one PUT and the object is left locked
 * for the activation that follows. Status is reported from objectStatus, never from the version
 * of the document, which is always M (lesson of patch 0002).
 */
import { MEDIA_TYPES, bwSeg, createClientFromEnv, freshRead, type BwClient } from '../bw/client.js';
import { validateArgs } from '../format/validate.js';
import {
  adsoAccept,
  adsoTypeCandidates,
  buildAdsoElement,
  bwCreateAdso,
  injectElement,
  removeElement,
  setRootAttr,
  typePresets,
} from '../legacy/adso.js';
import { parseInfoObjectProps } from '../legacy/infoobject.js';
import { ToolError } from '../format/errors.js';
import { bwDelete } from '../legacy/delete.js';
import { planningPart } from './planning.js';
import { bwGetPushSchema } from '../legacy/push.js';
import type { JsonObject } from '../catalog/tools.js';
import {
  FIELD_PROPERTIES,
  checkFieldEntries,
  checkFieldProperties,
  editField,
  entryName,
  pureFieldElement,
  type FieldEntry,
  type FieldProps,
} from './adso-fields.js';
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

const PRESETS = Object.keys(typePresets);
const NAMES = { type: 'array', items: { type: 'string' } };

/** InfoObject names or field objects; the objects are checked by checkFieldEntries. */
const FIELDS = { type: 'array', items: {} };
const COPY_FROM: JsonObject = {
  type: 'object',
  properties: { type: { type: 'string', enum: ['ADSO', 'RSDS'] }, name: { type: 'string' }, source_system: { type: 'string' } },
  required: ['type', 'name'],
  additionalProperties: false,
};
/** Single ADSO flags beyond the presets; each maps to one attribute of the document root. */
const SETTING_ATTR: Record<string, string> = {
  change_log: 'writeChangelog',
  unique_records: 'uniqueDataRecords',
  snapshot: 'snapShotScenario',
  planning: 'planningMode',
};
const SETTINGS: JsonObject = {
  type: 'object',
  properties: Object.fromEntries(Object.keys(SETTING_ATTR).map((k) => [k, { type: 'boolean' }])),
  additionalProperties: false,
};
const CREATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    info_area: { type: 'string' },
    preset: { type: 'string', enum: PRESETS },
    fields: FIELDS,
    keys: NAMES,
    write_interface: { type: 'boolean' },
    field_properties: FIELD_PROPERTIES,
    settings: SETTINGS,
    copy_from: COPY_FROM,
  },
  required: ['description', 'info_area'],
  additionalProperties: false,
};
const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    preset: { type: 'string', enum: PRESETS },
    fields: { ...FIELDS, minItems: 1 },
    fields_add: FIELDS,
    fields_remove: NAMES,
    keys: NAMES,
    write_interface: { type: 'boolean' },
    field_properties: FIELD_PROPERTIES,
    settings: SETTINGS,
  },
  additionalProperties: false,
};

export interface AdsoField {
  name: string;
  infoObject?: string;
  kind: 'CHA' | 'KYF' | 'pure';
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  currency?: string;
  /** Field holding the currency or unit of this key figure. */
  reference?: string;
  aggregation?: string;
  label: string;
  group?: string;
}

export interface AdsoModel {
  name: string;
  label: string;
  infoArea?: string;
  package?: string;
  status?: string;
  presets: string[];
  writeInterface: boolean;
  flags: Record<string, string>;
  fields: AdsoField[];
  keys: string[];
  groups: string[];
  tables: string[];
}

const FLAG_NAMES = ['activateData', 'writeChangelog', 'isReportingObject', 'cubeDeltaOnly', 'directUpdate', 'noAqDeletion', 'uniqueDataRecords', 'snapShotScenario', 'planningMode', 'pushMode'];

export function parseAdso(name: string, xml: string): AdsoModel {
  const root = xml.match(/<adso:dataStore\b[^>]*>/)?.[0] ?? '';
  const attr = (src: string, a: string) => src.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
  const flags: Record<string, string> = {};
  for (const f of FLAG_NAMES) {
    const v = attr(root, f);
    if (v !== undefined) flags[f] = v;
  }
  const fields: AdsoField[] = [];
  for (const m of xml.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)) {
    const [, attrs, body] = m;
    const inline = body.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
    const num = (a: string) => (attr(inline, a) !== undefined ? Number(attr(inline, a)) : undefined);
    const objectType = body.match(/<consumptionViewProperties\b[^>]*\bobjectType="([^"]*)"/)?.[1];
    const infoObject = attr(attrs, 'infoObjectName');
    fields.push({
      name: attr(attrs, 'name') ?? '',
      infoObject,
      kind: !infoObject ? 'pure' : objectType === 'KYF' || attr(inline, 'semanticType') === 'amount' ? 'KYF' : 'CHA',
      dataType: attr(inline, 'name') ?? '',
      length: num('length'),
      precision: num('precision'),
      scale: num('scale'),
      currency: body.match(/<fixed(?:Currency|Unit)>([^<]+)<\/fixed(?:Currency|Unit)>/)?.[1],
      reference: body.match(/<unitCurrencyElement>[^<]*?([A-Z0-9_]+)<\/unitCurrencyElement>/)?.[1],
      aggregation: attr(attrs, 'aggregationBehavior'),
      // A label of the ADSO's own (field properties) wins over the InfoObject text.
      label: xmlDecode(
        body.match(/<localProperties\b[^>]*>\s*<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ??
          body.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ??
          '',
      ),
      group: attr(attrs, 'dimension')?.replace(/^#\/\/\//, '').replace(/§$/, ''),
    });
  }
  const loc = locationFromXml(xml);
  return {
    name: name.toUpperCase(),
    label: xmlDecode(xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
    infoArea: loc.infoArea,
    package: loc.package,
    status: documentStatus(xml),
    presets: adsoTypeCandidates(root),
    writeInterface: flags.pushMode === 'true',
    flags,
    fields,
    keys: [...xml.matchAll(/<keyElement>[^<]*?([A-Z0-9_/]+)<\/keyElement>/g)].map((k) => k[1].replace(/^.*\//, '')),
    groups: [...xml.matchAll(/<dimension\b[^>]*\bname="([^"]+)"/g)].map((d) => d[1]),
    tables: [...xml.matchAll(/<tables\b[^>]*\btableName="([^"]+)"[^>]*\btableType="([^"]+)"/g)].map((t) => `${t[1]} (${t[2]})`),
  };
}

function fieldType(f: AdsoField): string {
  const size =
    f.length !== undefined ? ` ${f.length}${f.dataType === 'DEC' && f.precision ? `,${f.precision}` : ''}` : f.precision !== undefined ? ` ${f.precision}${f.scale !== undefined ? `,${f.scale}` : ''}` : '';
  const extra = [
    f.currency ?? (f.reference ? `→ ${f.reference}` : undefined),
    f.kind !== 'CHA' && f.aggregation && f.aggregation !== 'NONE' ? f.aggregation : undefined,
  ].filter(Boolean);
  return `${f.dataType}${size}${extra.length ? ` ${extra.join(' · ')}` : ''}`;
}

export function summarizeAdso(m: AdsoModel, detail: 'summary' | 'full', part?: string): string {
  const head = `ADSO ${m.name} "${m.label}" · ${statusText(m.status)} · ${m.presets.join(' or ')}${m.writeInterface ? ' · write interface' : ''}${m.flags.planningMode === 'true' ? ' · planning' : ''} · InfoArea ${m.infoArea ?? '?'} · package ${m.package ?? '?'}`;
  const keys = new Set(m.keys);
  const fieldLines = () => {
    const n = Math.max(4, ...m.fields.map((f) => f.name.length));
    const t = Math.max(4, ...m.fields.map((f) => fieldType(f).length));
    return m.fields.map(
      (f) =>
        `  ${keys.has(f.name) ? '*' : ' '} ${f.name.padEnd(n)}  ${fieldType(f).padEnd(t)}  ${f.label}${f.kind === 'pure' ? ' (field)' : ''}${detail === 'full' && f.group ? `  [group ${f.group}]` : ''}`.trimEnd(),
    );
  };
  const p = part?.toLowerCase();
  if (p === 'keys') return `${head}\nKey: ${m.keys.join(', ') || 'none'}`;
  if (p === 'settings') return `${head}\n${Object.entries(m.flags).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const lines = [head, `Fields (${m.fields.length}, key marked *):`, ...fieldLines()];
  if (p === 'fields') return lines.join('\n');
  if (detail === 'full') {
    lines.push(`Settings: ${Object.entries(m.flags).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    lines.push(`Field groups: ${m.groups.join(', ') || 'none'}`);
    if (m.tables.length > 0) lines.push(`Tables: ${m.tables.join(', ')}`);
  }
  return lines.join('\n');
}

async function readDoc(name: string): Promise<{ xml: string; timestamp?: string }> {
  const r = await freshRead(`/sap/bw/modeling/adso/${bwSeg(name.toLowerCase())}/m`, adsoAccept());
  return { xml: r.body, timestamp: r.headers['timestamp'] ?? r.headers['TIMESTAMP'] };
}

const upper = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : []);

/** `fields` entries as given: InfoObject names upper-cased, field objects with an upper-case name. */
function entriesOf(v: unknown): FieldEntry[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === 'string' ? e.toUpperCase() : ({ ...(e as object), name: entryName(e) } as FieldEntry)));
}

function propsOf(v: unknown): (FieldProps & { field: string })[] {
  if (!Array.isArray(v)) return [];
  return (v as JsonObject[]).map((p) => ({
    field: String(p.field).toUpperCase(),
    ...(typeof p.label === 'string' ? { label: p.label } : {}),
    ...(typeof p.group === 'string' ? { group: p.group } : {}),
    ...(typeof p.aggregation === 'string' ? { aggregation: p.aggregation } : {}),
    ...(typeof p.currency === 'string' ? { currency: p.currency } : {}),
    ...(typeof p.unit === 'string' ? { unit: p.unit } : {}),
    ...(typeof p.reference === 'string' ? { reference: p.reference } : {}),
  }));
}

interface Desired {
  fields?: FieldEntry[];
  add?: FieldEntry[];
  remove?: string[];
  props?: (FieldProps & { field: string })[];
  settings?: Record<string, boolean>;
  keys?: string[];
  label?: string;
  preset?: string;
  writeInterface?: boolean;
}

/** Apply the desired state to the document; returns the new document and what changed. */
async function applyDesired(
  name: string,
  xml: string,
  d: Desired,
  reader: () => Pick<BwClient, 'get'> = createClientFromEnv,
): Promise<{ xml: string; notes: string[] }> {
  const current = parseAdso(name, xml);
  const present = new Set(current.fields.map((f) => f.name));
  const notes: string[] = [];
  let out = xml;

  // Entries are InfoObject names or field objects; the objects of new fields are kept by name.
  const entries = new Map<string, FieldEntry>();
  for (const e of [...(d.fields ?? []), ...(d.add ?? [])]) entries.set(entryName(e), e);
  const target = d.fields
    ? d.fields.map(entryName)
    : [...[...present].filter((f) => !(d.remove ?? []).includes(f)), ...(d.add ?? []).map(entryName).filter((f) => !present.has(f))];
  const toRemove = [...present].filter((f) => !target.includes(f));
  const toAdd = target.filter((f) => !present.has(f));
  for (const f of toRemove) out = removeElement(out, f);
  const props: (FieldProps & { field: string })[] = [];
  if (toAdd.length > 0) {
    // One fresh reader for all InfoObjects: objects written earlier in this call through the
    // shared client could otherwise be served from a stale session buffer.
    const iobjReader = reader();
    for (const f of toAdd) {
      const e = entries.get(f);
      if (e && typeof e === 'object') {
        out = injectElement(out, pureFieldElement(out, e, current.name));
        if (e.currency || e.unit || e.reference) props.push({ field: f, currency: e.currency, unit: e.unit, reference: e.reference });
        continue;
      }
      const iobj = await iobjReader.get(`/sap/bw/modeling/iobj/${bwSeg(f.toLowerCase())}/m?forceCacheUpdate=true`, MEDIA_TYPES['iobj']);
      out = injectElement(out, buildAdsoElement(f, parseInfoObjectProps(iobj.body)));
    }
  }
  const changedProps: string[] = [];
  for (const p of [...props, ...(d.props ?? [])]) {
    const r = editField(out, p.field, p, current.name);
    out = r.xml;
    if (!toAdd.includes(p.field.toUpperCase())) changedProps.push(...r.changed);
  }
  if (toAdd.length) notes.push(`added ${toAdd.join(', ')}`);
  if (toRemove.length) notes.push(`removed ${toRemove.join(', ')}`);
  if (changedProps.length) notes.push(changedProps.join(', '));

  const currentKeys = current.keys.filter((k) => target.includes(k));
  const keys = d.keys ?? currentKeys;
  if (keys.join(',') !== current.keys.join(',')) {
    out = out.replace(/[ \t]*<keyElement>[^<]*<\/keyElement>\n?/g, '');
    if (keys.length > 0) {
      const block = keys.map((k) => `  <keyElement>#///${k}</keyElement>`).join('\n') + '\n';
      out = out.includes('<tlogoProperties') ? out.replace('<tlogoProperties', `${block}  <tlogoProperties`) : out.replace('</adso:dataStore>', `${block}</adso:dataStore>`);
    }
    notes.push(`key ${keys.join('+') || 'none'}`);
  }

  if (d.label !== undefined && d.label !== current.label) {
    out = out.replace(/<endUserTexts\b[^>]*\/>/, `<endUserTexts label="${xmlEscape(d.label)}"/>`);
    notes.push('description');
  }
  if (d.preset !== undefined && !current.presets.includes(d.preset)) {
    for (const [a, v] of Object.entries(typePresets[d.preset])) out = setRootAttr(out, a, String(v));
    notes.push(`preset ${d.preset}`);
  }
  for (const [k, v] of Object.entries(d.settings ?? {})) {
    const a = SETTING_ATTR[k];
    if (!a || current.flags[a] === String(v)) continue;
    out = setRootAttr(out, a, String(v));
    notes.push(`${k.replace('_', ' ')} ${v ? 'on' : 'off'}`);
  }
  if (d.writeInterface !== undefined && d.writeInterface !== current.writeInterface) {
    out = setRootAttr(out, 'pushMode', String(d.writeInterface));
    notes.push(`write interface ${d.writeInterface ? 'on' : 'off'}`);
  }
  if (out !== xml && !out.includes('snapShotScenario')) {
    out = out.replace('nextRemodelingVersion="1"', 'nextRemodelingVersion="1" snapShotScenario="false"');
  }
  return { xml: out, notes };
}

/** Lock, PUT, keep the lock for the activation. Releases the lock if the PUT fails. */
async function save(client: BwClient, name: string, xml: string, timestamp: string | undefined, transport?: string): Promise<string> {
  const handle = await client.lock('adso', name.toLowerCase());
  try {
    await client.put('adso', name.toLowerCase(), handle, xml, timestamp, transport);
  } catch (err) {
    await client.unlock('adso', name.toLowerCase()).catch(() => undefined);
    throw err;
  }
  return handle;
}

export const adsoAdapter: ObjectAdapter = {
  type: 'ADSO',
  label: 'DataStore object (advanced)',
  activationType: 'adso',

  describe(action) {
    const lines =
      action === 'create'
        ? [
            'ADSO create spec',
            '  description      text, max 60                      (required)',
            '  info_area        InfoArea name                     (required)',
            '  fields           in order; each an InfoObject name or a field without InfoObject:',
            '                   {name, type, length, precision, scale, label, aggregation, group,',
            '                    currency | unit | reference}',
            '                   type CHAR NUMC DATS TIMS CUKY UNIT LANG DEC CURR QUAN INT1-8 FLTP STRING;',
            '                   CHAR/NUMC need length, DEC precision, CURR/QUAN scale and a currency',
            '                   or unit: fixed (currency "EUR", unit "KG") or reference = the CUKY/UNIT field',
            '  keys             subset of fields (characteristics); empty = no key',
            '  field_properties list of {field, label, group, aggregation, currency | unit | reference};',
            '                   aggregation only for fields without InfoObject',
            '  settings         {change_log, unique_records, snapshot, planning}: single flags (true | false)',
            '  copy_from        {type: ADSO | RSDS, name, source_system}: take fields, key and settings',
            '                   from a template; fields are then added to the proposed ones',
            `  preset           ${PRESETS.join(' | ')} (default standard)`,
            '  write_interface  true | false (default false)',
            'group = a field group the ADSO declares (e.g. GROUP1). The ADSO is created with all fields',
            'and the key in one step. InfoObjects created in the',
            'same bw_write call are written and activated first.',
            'Example',
            '  {"action":"create","type":"ADSO","name":"ZSALES01","spec":{"description":"Sales","info_area":"ZSALES","fields":["ZCUSTOMER","ZPRODUCT","ZAMOUNT"],"keys":["ZCUSTOMER","ZPRODUCT"]}}',
          ]
        : [
            'ADSO update spec (only the named properties change)',
            '  description      text, max 60',
            '  fields           complete target list (fields not listed are removed); entries as in create',
            '  fields_add       fields to add (instead of fields); entries as in create',
            '  fields_remove    fields to remove (instead of fields)',
            '  keys             complete key list',
            `  preset           ${PRESETS.join(' | ')}`,
            '  write_interface  true | false',
            '  field_properties list of {field, label, group, aggregation, currency | unit | reference};',
            '                   aggregation only for fields without InfoObject',
            '  settings         {change_log, unique_records, snapshot, planning}',
            'Changing fields of an ADSO with data may require remodeling; BW reports this on activation.',
            'Example',
            '  {"action":"update","type":"ADSO","name":"ZSALES01","spec":{"fields_add":["ZREGION",{"name":"DOCNO","type":"CHAR","length":10,"label":"Document"}]}}',
          ];
    return lines.join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (action === 'create' && !/^[A-Z][A-Z0-9_]{1,8}$/i.test(name)) errors.push('name: 2–9 characters A–Z, 0–9, _, starting with a letter');
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    if (s.fields !== undefined && (s.fields_add !== undefined || s.fields_remove !== undefined)) errors.push('fields: use either fields or fields_add/fields_remove');
    if (action === 'create' && s.fields === undefined && s.copy_from === undefined) errors.push('fields: required unless copy_from is given');
    const cf = s.copy_from as JsonObject | undefined;
    if (cf?.type === 'RSDS' && !cf.source_system) errors.push('copy_from.source_system: required for a DataSource');
    checkFieldEntries(s.fields, 'fields', errors);
    checkFieldEntries(s.fields_add, 'fields_add', errors);
    checkFieldProperties(s.field_properties, errors);
    const fields = (Array.isArray(s.fields) ? s.fields : []).map(entryName);
    if (s.keys !== undefined && s.fields !== undefined && !cf) {
      for (const k of upper(s.keys)) if (!fields.includes(k)) errors.push(`keys: ${k} is not in fields`);
    }
    if (new Set(fields).size !== fields.length) errors.push('fields: duplicate names');
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action === 'delete' || !spec) return [];
    const refs: ObjectRef[] = [];
    if (typeof spec.info_area === 'string') refs.push({ type: 'AREA', name: spec.info_area.toUpperCase() });
    for (const e of [...entriesOf(spec.fields), ...entriesOf(spec.fields_add)]) if (typeof e === 'string') refs.push({ type: 'IOBJ', name: e });
    const cf = spec.copy_from as JsonObject | undefined;
    if (cf && (cf.type === 'ADSO' || cf.type === 'RSDS')) refs.push({ type: cf.type, name: String(cf.name).toUpperCase() });
    return refs;
  },

  targetInfoArea(_name, spec) {
    return typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
  },

  async locate(_client, name) {
    try {
      return locationFromXml((await readDoc(name)).xml);
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async read(_client, name, { detail, part }) {
    const { xml } = await readDoc(name);
    if (detail === 'raw') return xml;
    const m = parseAdso(name, xml);
    if (part?.toLowerCase() === 'push_schema') {
      const text = await bwGetPushSchema(_client, name);
      const { parsePushSchema, summarizePushSchema } = await import('../tools/runtime.js');
      try {
        return summarizePushSchema(name, parsePushSchema(text));
      } catch {
        return text;
      }
    }
    if (part?.toLowerCase() === 'planning') {
      const head = summarizeAdso(m, detail, 'keys').split('\n')[0];
      if (m.flags.planningMode !== 'true') return `${head}\nNot planning-enabled (settings.planning false), so it has no planning properties.`;
      return `${head}\n${await planningPart(_client, name)}`;
    }
    return summarizeAdso(m, detail, part);
  },

  async create(name, spec, ctx) {
    const preset = typeof spec.preset === 'string' ? spec.preset : 'standard';
    const cf = spec.copy_from as JsonObject | undefined;
    await bwCreateAdso(
      ctx.client,
      name,
      xmlEscape(String(spec.description)),
      String(spec.info_area),
      cf ? 'from_template' : 'empty',
      cf ? String(cf.name).toUpperCase() : undefined,
      cf?.type === 'RSDS' ? 'RSDS' : 'ADSO',
      cf?.source_system ? String(cf.source_system).toUpperCase() : undefined,
      preset,
      ctx.package,
      spec.write_interface === true,
    );
    const doc = await readDoc(name);
    const fields = entriesOf(spec.fields);
    const { xml } = await applyDesired(name, doc.xml, {
      // With a template, fields are added to the proposed ones and the key is kept unless given.
      ...(cf ? { add: fields } : { fields }),
      ...(spec.keys !== undefined || !cf ? { keys: upper(spec.keys) } : {}),
      ...(cf && spec.preset === undefined ? {} : { preset }),
      props: propsOf(spec.field_properties),
      settings: spec.settings as Record<string, boolean> | undefined,
    });
    const handle = await save(ctx.client, name, xml, doc.timestamp, ctx.transport);
    const m = parseAdso(name, xml);
    return {
      status: 'created',
      activation: { lockHandle: handle },
      notes: [
        `${cf ? `from ${cf.type} ${String(cf.name).toUpperCase()}, ` : `${preset}, `}${m.fields.length} fields, key ${m.keys.length ? m.keys.join('+') : 'none'}`,
      ],
    };
  },

  async update(name, spec, ctx) {
    const doc = await readDoc(name);
    // A create of an existing ADSO arrives here with info_area; fine as long as it matches.
    const area = typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
    const currentArea = locationFromXml(doc.xml).infoArea;
    if (area && area !== currentArea) {
      throw new ToolError('not_implemented', `${name.toUpperCase()} is in InfoArea ${currentArea}; moving it is not supported yet.`, 'Leave info_area out or give the current one.');
    }
    const { xml, notes } = await applyDesired(name, doc.xml, {
      fields: spec.fields !== undefined ? entriesOf(spec.fields) : undefined,
      add: entriesOf(spec.fields_add),
      props: propsOf(spec.field_properties),
      settings: spec.settings as Record<string, boolean> | undefined,
      remove: upper(spec.fields_remove),
      keys: spec.keys !== undefined ? upper(spec.keys) : undefined,
      label: typeof spec.description === 'string' ? spec.description : undefined,
      preset: typeof spec.preset === 'string' ? spec.preset : undefined,
      writeInterface: typeof spec.write_interface === 'boolean' ? spec.write_interface : undefined,
    });
    if (xml === doc.xml) return { status: 'unchanged' };
    const handle = await save(ctx.client, name, xml, doc.timestamp, ctx.transport);
    return { status: 'changed', activation: { lockHandle: handle }, notes };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'adso', name);
    return { status: 'deleted' };
  },
};

/** For tests: the parts of the write path that work on the document only. */
export const __test = { applyDesired };
