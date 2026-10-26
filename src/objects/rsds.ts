/**
 * DataSource (RSDS): read. A DataSource is identified by name and source system.
 */
import { MEDIA_TYPES, bwEscapeName, bwSeg, type BwClient } from '../bw/client.js';
import { ToolError } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import type { JsonObject } from '../catalog/tools.js';
import { bwChangeDatasourceDelta, bwCreateDatasource, bwSetDatasourceFields } from '../legacy/datasource.js';
import {
  isNotFound,
  locationFromXml,
  statusText,
  xmlDecode,
  xmlEscape,
  type ObjectAdapter,
  type ObjectReader,
  type ReadOptions,
  type Spec,
  type WriteAction,
} from './adapter.js';
import { attr, objectStatus, startTag } from './flow.js';

const RSDS_ACCEPT = 'application/vnd.sap.bw.modeling.rsds-v1_0_0+xml, application/vnd.sap.bw.modeling.rsds-v1_1_0+xml';

export interface RsdsField {
  name: string;
  type: string;
  size: string;
  label: string;
  key: boolean;
  transfer: boolean;
}

export interface RsdsModel {
  name: string;
  sourceSystem: string;
  description: string;
  status?: string;
  package?: string;
  kind?: string;
  delta?: string;
  adapter?: string;
  external?: string;
  fields: RsdsField[];
}

export function parseRsds(name: string, sourceSystem: string, xml: string, headerStatus?: string): RsdsModel {
  const root = xml.match(/<rsds:dataSource\b[^>]*>/)?.[0] ?? '';
  const segStart = xml.indexOf('<segment');
  const header = segStart >= 0 ? xml.slice(0, segStart) : xml;
  const segment = xml.match(/<segment\b[^>]*ID="0001"[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? xml.match(/<segment\b[^>]*>([\s\S]*?)<\/segment>/)?.[1] ?? '';
  const keys = new Set([...segment.matchAll(/<keyField>#\/\/\/[^/]+\/([^<]+)<\/keyField>/g)].map((m) => m[1].trim()));
  const fields: RsdsField[] = [];
  for (const m of segment.matchAll(/<field\b([^>]*)>([\s\S]*?)<\/field>/g)) {
    const [, attrs, body] = m;
    const inline = startTag(body, 'inlineType');
    const precision = attr(inline, 'precision');
    const scale = attr(inline, 'scale');
    const props = startTag(body, 'fieldProperties');
    const fname = attr(`<f ${attrs}>`, 'name') ?? '';
    fields.push({
      name: fname,
      type: attr(inline, 'name') ?? '',
      size: precision && precision !== '0' ? `${precision}${scale && scale !== '0' ? `,${scale}` : ''}` : attr(inline, 'length') ?? '',
      label: xmlDecode(body.match(/<(?:descriptions?|endUserTexts)\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
      key: keys.has(fname),
      transfer: attr(props, 'transfer') !== 'false',
    });
  }
  const used = [...xml.matchAll(/<adapter\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes('currentlyUsed="true"'));
  return {
    name: (attr(root, 'name') ?? name).toUpperCase(),
    sourceSystem: (attr(root, 'sourceSystemName') ?? sourceSystem).toUpperCase(),
    description: xmlDecode(header.match(/<(?:descriptions?|endUserTexts)\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
    status: objectStatus(xml, headerStatus),
    package: locationFromXml(xml).package,
    kind: attr(root, 'type'),
    delta: xml.match(/<deltaProperties\b[^>]*\bdelta="([^"]*)"/)?.[1],
    adapter: used ? (attr(used, 'xsi:type') ?? '').replace(/^rsds:/, '') || attr(used, 'name') : undefined,
    external: used ? attr(used, 'externalObject') || undefined : undefined,
    fields,
  };
}

export function summarizeRsds(m: RsdsModel, part?: string): string {
  const head = [
    `RSDS ${m.name} (${m.sourceSystem}) "${m.description}" · ${statusText(m.status)} · package ${m.package ?? '?'}`,
    `Type ${m.kind ?? '?'} · delta ${m.delta || 'none (full loads only)'}${m.adapter ? ` · adapter ${m.adapter}` : ''}${m.external ? ` · source ${m.external}` : ''}`,
  ];
  const n = Math.max(4, ...m.fields.map((f) => f.name.length));
  const fields = [
    `Fields (${m.fields.length}, key marked *, not transferred marked -):`,
    ...m.fields.map((f) => `  ${f.key ? '*' : f.transfer ? ' ' : '-'} ${f.name.padEnd(n)}  ${`${f.type} ${f.size}`.trim().padEnd(10)}  ${f.label === f.name ? '' : f.label}`.trimEnd()),
  ];
  if (part?.toLowerCase() === 'keys') return [...head, `Key: ${m.fields.filter((f) => f.key).map((f) => f.name).join(', ') || 'none'}`].join('\n');
  return [...head, ...fields].join('\n');
}

function needSystem(sourceSystem?: string): string {
  if (!sourceSystem) throw new ToolError('validation', 'source_system is required for a DataSource (RSDS).', 'bw_search(types=["RSDS"]) shows each DataSource with its source system.');
  return sourceSystem.toUpperCase();
}

async function readDoc(client: BwClient, name: string, sourceSystem: string): Promise<{ xml: string; status?: string }> {
  const r = await client.get(`/sap/bw/modeling/rsds/${encodeURIComponent(bwEscapeName(name))}/${sourceSystem}/m`, RSDS_ACCEPT);
  return { xml: r.body, status: r.headers['object_status'] };
}

export const rsdsReader: ObjectReader = {
  type: 'RSDS',
  label: 'DataSource',
  async locate(client, name, sourceSystem) {
    try {
      return locationFromXml((await readDoc(client, name, needSystem(sourceSystem))).xml);
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },
  async read(client, name, { detail, part, sourceSystem }: ReadOptions) {
    const lsys = needSystem(sourceSystem);
    const { xml, status } = await readDoc(client, name, lsys);
    if (detail === 'raw') return xml;
    return summarizeRsds(parseRsds(name, lsys, xml, status), part);
  },
};

// ── Writing ──────────────────────────────────────────────────────────────────

const CREATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    source_object: { type: 'string' },
    application_component: { type: 'string' },
  },
  required: ['source_object'],
  additionalProperties: false,
};

const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    delta: { type: 'string' },
    fields: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, transfer: { type: 'boolean' } }, required: ['name', 'transfer'], additionalProperties: false },
    },
    language_field: { type: 'string' },
    description: { type: 'string' },
    source_object: { type: 'string' },
    application_component: { type: 'string' },
  },
  additionalProperties: false,
};

/** A legacy answer: JSON that may say success false. */
function refused(text: string, what: string): void {
  try {
    const r = JSON.parse(text) as { success?: boolean; message?: string; error?: string };
    if (r.success === false) throw new ToolError('validation', `${what}: ${r.message ?? r.error ?? 'refused'}`);
  } catch (err) {
    if (err instanceof ToolError) throw err;
  }
}

/** Lock, delete and unlock a DataSource; its key has two path segments (name and source system). */
async function deleteDataSource(client: BwClient, name: string, sourceSystem: string): Promise<void> {
  const base = `/sap/bw/modeling/rsds/${bwSeg(name.toLowerCase())}/${sourceSystem}`;
  const media = MEDIA_TYPES['rsds'];
  const csrf = await client.getCsrfToken();
  const lock = await client.rawPost(`${base}?action=lock`, '', { Accept: media, 'x-csrf-token': csrf });
  const handle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`Lock rsds/${name}/${sourceSystem} → no lock handle\n${lock.body.slice(0, 400)}`);
  try {
    await client.rawDelete(`${base}/m?lockHandle=${encodeURIComponent(handle)}`, { 'Content-Type': media, Accept: media });
  } finally {
    await client.rawPost(`${base}?action=unlock`, '', { 'Content-Type': media, Accept: media, 'x-csrf-token': await client.getCsrfToken() }).catch(() => undefined);
  }
}

export const rsdsAdapter: ObjectAdapter = {
  ...rsdsReader,
  activationType: 'rsds',

  describe(action) {
    return (
      action === 'create'
        ? [
            'RSDS create spec (DataSource on a SAP HANA source system, e.g. SELF; give source_system',
            'next to name in the object)',
            '  source_object          table, view or CDS view in the source system, exact case  (required)',
            '  description            text, max 60 (default: source_object)',
            '  application_component  default: none (NODESNOTCONNECTED)',
            'BW takes the fields and key from the source object. Delta, field selection and ODP',
            'sources are not supported yet. The DataSource is activated in the same call.',
            'Example',
            '  {"action":"create","type":"RSDS","name":"ZDS_SCARR","source_system":"SELF","spec":{"source_object":"SCARR","description":"Airlines"}}',
          ]
        : [
            'RSDS update spec (give source_system next to name)',
            '  delta           delta process code, e.g. "FIL0"; "" = full loads only',
            '  fields          [{name, transfer}]: transfer false leaves a field out of the load',
            '  language_field  field that carries the language of a text DataSource',
            'The DataSource is activated in the same call.',
            'Example',
            '  {"action":"update","type":"RSDS","name":"ZDS_SCARR","source_system":"SELF","spec":{"fields":[{"name":"URL","transfer":false}]}}',
          ]
    ).join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    if (action === 'update') return validateArgs(UPDATE, s).errors;
    const errors = validateArgs(CREATE, s).errors;
    if (!/^[A-Z][A-Z0-9_]{1,29}$/i.test(name)) errors.push('name: 2–30 characters A–Z, 0–9, _, starting with a letter');
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    return errors;
  },

  dependsOn() {
    return [];
  },

  targetInfoArea() {
    return undefined;
  },

  async create(name, spec, ctx) {
    if (!ctx.sourceSystem) throw new ToolError('validation', 'source_system is required for a DataSource (RSDS).', 'Give source_system next to name, e.g. "SELF".');
    if (ctx.package !== '$TMP') throw new ToolError('not_implemented', 'DataSources are created in package $TMP only for now.', 'Use package "$TMP".');
    await bwCreateDatasource(
      ctx.client,
      name,
      ctx.sourceSystem,
      typeof spec.application_component === 'string' ? spec.application_component : 'NODESNOTCONNECTED',
      String(spec.source_object),
      typeof spec.description === 'string' ? xmlEscape(spec.description) : undefined,
    );
    return { status: 'created', activation: { lockHandle: '' }, notes: [`from ${String(spec.source_object)}`] };
  },

  async update(name, spec, ctx) {
    const { xml } = await readDoc(ctx.client, name, needSystem(ctx.sourceSystem));
    const m = parseRsds(name, ctx.sourceSystem ?? '', xml);
    if (spec.source_object !== undefined && m.external && String(spec.source_object) !== m.external) {
      throw new ToolError('not_implemented', `${name} reads from ${m.external}; changing the source object is not supported.`, 'Delete the DataSource and create it again.');
    }
    const system = needSystem(ctx.sourceSystem);
    const notes: string[] = [];
    if (typeof spec.delta === 'string' && spec.delta.toUpperCase() !== (m.delta ?? '').toUpperCase()) {
      refused(await bwChangeDatasourceDelta(ctx.client, { datasourceName: name, sourceSystem: system, deltaProcess: spec.delta.toUpperCase() }), 'delta');
      notes.push(`delta ${spec.delta.toUpperCase() || 'none'}`);
    }
    const wanted = ((spec.fields as JsonObject[] | undefined) ?? []).map((f) => ({ name: String(f.name).toUpperCase(), transfer: f.transfer === true }));
    const unknown = wanted.filter((f) => !m.fields.some((x) => x.name.toUpperCase() === f.name));
    if (unknown.length) throw new ToolError('validation', `Not fields of ${name}: ${unknown.map((f) => f.name).join(', ')}.`, `Fields: ${m.fields.map((x) => x.name).join(', ')}.`);
    const changes = wanted.filter((f) => m.fields.find((x) => x.name.toUpperCase() === f.name)!.transfer !== f.transfer);
    const lang = typeof spec.language_field === 'string' ? spec.language_field.toUpperCase() : undefined;
    if (changes.length || lang !== undefined) {
      refused(await bwSetDatasourceFields(ctx.client, { datasourceName: name, sourceSystem: system, ...(changes.length ? { fields: changes } : {}), ...(lang !== undefined ? { languageField: lang } : {}), ...(ctx.transport ? { transport: ctx.transport } : {}) }), 'fields');
      if (changes.length) notes.push(`${changes.length} field${changes.length === 1 ? '' : 's'} ${changes.every((c) => !c.transfer) ? 'left out' : changes.every((c) => c.transfer) ? 'transferred' : 'changed'}`);
      if (lang !== undefined) notes.push(`language field ${lang}`);
    }
    return notes.length ? { status: 'changed', activation: { lockHandle: '' }, notes } : { status: 'unchanged' };
  },

  async delete(name, ctx) {
    await deleteDataSource(ctx.client, name, needSystem(ctx.sourceSystem));
    return { status: 'deleted' };
  },
};
