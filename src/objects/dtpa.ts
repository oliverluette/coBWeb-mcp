/**
 * Data transfer process (DTPA): read.
 */
import { MEDIA_TYPES, bwSeg, freshRead, type BwClient } from '../bw/client.js';
import { bwCreateDtp, bwSetDtpFilterRoutine, bwUpdateDtp, parseDtpXml, type DtpFilterSelectionInput, type DtpInfo } from '../legacy/dtp.js';
import { bwDelete } from '../legacy/delete.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError } from '../format/errors.js';
import { validateArgs } from '../format/validate.js';
import { xref } from '../tools/relations.js';
import {
  isNotFound,
  locationFromXml,
  statusText,
  xmlDecode,
  type Location,
  type ObjectAdapter,
  type ObjectReader,
  type ObjectRef,
  type ReadOptions,
  type Spec,
  type WriteAction,
} from './adapter.js';
import { attr, endLabel, flowEnd, flowIdentity, objectStatus, parseIdentity, sameTitle, splitDataSource, startTag, trfnTitle, type FlowEnd } from './flow.js';
import { findTrfn } from './trfn.js';

/** Source or target of a DTP: the `tlogo` attribute holds the object type (type says DTASRC). */
function dtpEnd(xml: string, element: 'source' | 'target'): { type: string; name: string; sourceSystem?: string } {
  const tag = startTag(xml, element);
  const type = (attr(tag, 'tlogo') || attr(tag, 'type') || '?').toUpperCase();
  return { type, ...splitDataSource(type, attr(tag, 'name') ?? '') };
}

export function summarizeDtp(name: string, xml: string, info: DtpInfo, part?: string): string {
  const src = dtpEnd(xml, 'source');
  const tgt = dtpEnd(xml, 'target');
  const mode = info.extractionMode === 'F' ? 'full' : info.extractionMode === 'D' ? 'delta' : info.extractionMode || '?';
  const head = [
    `DTPA ${name.toUpperCase()} "${xmlDecode(info.description)}" · ${statusText(objectStatus(xml, info.status))} · ${mode}${info.packageSize ? ` · package size ${info.packageSize}` : ''}`,
    `${endLabel(src.type, src.name, src.sourceSystem)} → ${endLabel(tgt.type, tgt.name)}${info.transformation.name ? ` via TRFN ${info.transformation.name}` : ''}`,
  ];
  const filter: string[] = [];
  const open: string[] = [];
  for (const f of info.filterFields) {
    const sel = f.selections.map((s) => `${s.excluding ? 'not ' : ''}${OP_NAMES[s.operator] ?? s.operator} ${s.low === '' ? "''" : s.low}${s.operator === 'Between' && s.high ? `..${s.high}` : ''}`);
    if (f.hasRoutine) sel.push(`routine (${f.routineCode.length} lines)`);
    if (sel.length) filter.push(`  ${f.name}: ${sel.join('; ')}`);
    else if (f.selected) open.push(f.name);
  }
  const filterLines = [
    filter.length ? 'Filter:' : 'Filter: none',
    ...filter,
    ...(open.length ? [`  selectable without value: ${open.join(', ')}`] : []),
  ];
  const group = info.semanticGroupFields.filter((f) => f.isKey).map((f) => f.name);
  if (part?.toLowerCase() === 'filter') return [...head, ...filterLines].join('\n');
  const lines = [...head, ...filterLines, `Semantic group: ${group.join(', ') || 'none'}`];
  if (info.globalRoutineCode.length > 0) lines.push(`Global routine code: ${info.globalRoutineCode.length} lines`);
  return lines.join('\n');
}

async function readDoc(name: string): Promise<{ xml: string; status: string }> {
  // Fresh session: the shared client's buffer may serve a stale shadow of a DTP it touched.
  const r = await freshRead(`/sap/bw/modeling/dtpa/${bwSeg(name.toLowerCase())}/m`, MEDIA_TYPES['dtpa']);
  return { xml: r.body, status: r.headers['object_status'] ?? r.headers['OBJECT_STATUS'] ?? 'unknown' };
}

export const dtpaReader: ObjectReader = {
  type: 'DTPA',
  label: 'Data transfer process',
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
    return summarizeDtp(name, xml, parseDtpXml(xml, status), part);
  },
};

// ── Writing ──────────────────────────────────────────────────────────────────

const END: JsonObject = {
  type: 'object',
  properties: { type: { type: 'string' }, name: { type: 'string' }, source_system: { type: 'string' } },
  required: ['type', 'name'],
  additionalProperties: false,
};
const OPS: Record<string, string> = {
  eq: 'Equal',
  ne: 'NotEqual',
  between: 'Between',
  pattern: 'ContainsPattern',
  gt: 'GreaterThan',
  ge: 'GreaterEqual',
  lt: 'LessThan',
  le: 'LessEqual',
};
const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
const SELECTION: JsonObject = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: Object.keys(OPS) },
    low: { type: 'string' },
    high: { type: 'string' },
    exclude: { type: 'boolean' },
  },
  required: ['low'],
  additionalProperties: false,
};
const FILTER: JsonObject = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      field: { type: 'string' },
      values: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'boolean' },
      selections: { type: 'array', items: SELECTION },
    },
    required: ['field'],
    additionalProperties: false,
  },
};
const GROUP: JsonObject = { type: 'array', items: { type: 'string' } };
const CREATE: JsonObject = {
  type: 'object',
  properties: {
    source: END,
    target: END,
    description: { type: 'string' },
    mode: { type: 'string', enum: ['full', 'delta'] },
    filter: FILTER,
    semantic_group: GROUP,
  },
  required: ['source', 'target'],
  additionalProperties: false,
};
const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    mode: { type: 'string', enum: ['full', 'delta'] },
    filter: FILTER,
    semantic_group: GROUP,
    filter_routine: {
      type: 'object',
      properties: { field: { type: 'string' }, code: { type: 'string' }, global_code: { type: 'string' } },
      required: ['field', 'code'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** One field's filter in BW's terms; an empty list clears the field. */
interface FilterSpec {
  field: string;
  selections: DtpFilterSelectionInput[];
}

export function filtersOf(spec: Spec): FilterSpec[] {
  return ((spec.filter as JsonObject[] | undefined) ?? []).map((f) => {
    const field = String(f.field).toUpperCase();
    if (Array.isArray(f.selections)) {
      return {
        field,
        selections: (f.selections as JsonObject[]).map((x) => ({
          operator: OPS[String(x.op ?? 'eq')],
          sign: x.exclude === true ? 'E' : 'I',
          low: String(x.low),
          ...(x.high !== undefined ? { high: String(x.high) } : {}),
        })),
      };
    }
    const sign = f.exclude === true ? 'E' : 'I';
    return { field, selections: ((f.values as unknown[] | undefined) ?? []).map((v) => ({ operator: 'Equal', sign, low: String(v) })) };
  });
}

/** Order-insensitive key of a selection list, for the "unchanged" check. */
function selectionKey(list: { operator?: string; excluding?: boolean; sign?: string; low: string; high?: string }[]): string {
  return list
    // BW keeps a high value ("#") on single-value operators too; only an interval has one.
    .map((x) => `${x.operator ?? 'Equal'}|${x.excluding ?? x.sign === 'E' ? 'E' : 'I'}|${x.low}|${(x.operator ?? 'Equal') === 'Between' ? x.high ?? '' : ''}`)
    .sort()
    .join('\u0000');
}

function checkFilters(filter: unknown, errors: string[]): void {
  if (!Array.isArray(filter)) return;
  const seen = new Set<string>();
  for (const f of filter as JsonObject[]) {
    const field = String(f.field ?? '').toUpperCase();
    if (seen.has(field)) errors.push(`filter: ${field} is listed twice`);
    seen.add(field);
    if (f.values !== undefined && f.selections !== undefined) errors.push(`filter: ${field}: give either values or selections`);
    if (f.exclude !== undefined && f.values === undefined) errors.push(`filter: ${field}: exclude belongs to values; selections carry their own`);
    for (const x of (f.selections as JsonObject[] | undefined) ?? []) {
      const op = String(x.op ?? 'eq');
      if (op === 'between' && (x.high === undefined || x.low === '' || x.high === '')) errors.push(`filter: ${field}: between needs low and high`);
      if (op !== 'between' && x.high !== undefined) errors.push(`filter: ${field}: high only with op between`);
      if (x.low === '' && op !== 'eq' && op !== 'ne') errors.push(`filter: ${field}: an empty low (initial value) only with eq or ne`);
    }
  }
}

function ends(xml: string): { source: FlowEnd; target: FlowEnd } {
  return { source: dtpEnd(xml, 'source'), target: dtpEnd(xml, 'target') };
}

const sameEnd = (a: FlowEnd, b: FlowEnd) => a.type === b.type && a.name === b.name && (a.type !== 'RSDS' || a.sourceSystem === b.sourceSystem);

/** The transformations a DTP from source to target runs through: one, or two via an InfoSource. */
/**
 * The transformation chain, asked again in a fresh session when the first answer finds none: a
 * transformation activated a moment ago in the same bw_write call is missing from the where-used
 * index the writing session reads, and the DTP of that call was refused.
 */
async function chainSettled(client: BwClient, source: FlowEnd, target: FlowEnd): Promise<string[]> {
  try {
    return await chainOf(client, source, target);
  } catch (err) {
    if (!(err instanceof ToolError) || err.kind !== 'validation') throw err;
    for (const wait of [500, 1500, 3000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        return await chainOf(client.freshSession(), source, target);
      } catch (again) {
        if (!(again instanceof ToolError) || again.kind !== 'validation') throw again;
      }
    }
    throw err;
  }
}

async function chainOf(client: BwClient, source: FlowEnd, target: FlowEnd): Promise<string[]> {
  const direct = await findTrfn(client, source, target);
  if (direct) return [direct];
  for (const h of await xref(client, target.type, target.name, target.sourceSystem)) {
    const m = h.type === 'TRFN' ? h.title.match(/^\s*TRCS\s+(\S+)\s*->/i) : null;
    if (!m) continue;
    const viaTrcs = { type: 'TRCS', name: m[1].toUpperCase() };
    if (!sameTitle(h.title, trfnTitle(viaTrcs, target))) continue;
    const first = await findTrfn(client, source, viaTrcs);
    if (first) return [first, h.name];
  }
  throw new ToolError(
    'validation',
    `There is no active transformation from ${flowIdentity(source, target).replace(' → ', ' to ')}.`,
    'Create it first, in the same bw_write call (type TRFN) or before.',
  );
}

/**
 * The DTP's own name of a source field: InfoObject fields of a DataStore object carry the
 * /BIC/ prefix (ZCUSTOMER → /BIC/ZCUSTOMER), BW content InfoObjects drop the leading 0
 * (0RECORDMODE → RECORDMODE). A name the DTP does not know is passed on for BW to refuse.
 */
export function dtpField(field: string, available: string[]): string {
  const known = new Set(available.map((a) => a.toUpperCase()));
  const f = field.toUpperCase();
  for (const c of [f, `/BIC/${f}`, f.startsWith('0') ? f.slice(1) : '']) if (c && known.has(c)) return c;
  return f;
}

/** Date formats of USR01-DATFM that a DTP filter can take, as day/month/year order and separator. */
const DATE_FORMATS: Record<string, { order: 'DMY' | 'MDY' | 'YMD'; sep: string; label: string }> = {
  '1': { order: 'DMY', sep: '.', label: 'DD.MM.YYYY' },
  '2': { order: 'MDY', sep: '/', label: 'MM/DD/YYYY' },
  '3': { order: 'MDY', sep: '-', label: 'MM-DD-YYYY' },
  '4': { order: 'YMD', sep: '.', label: 'YYYY.MM.DD' },
  '5': { order: 'YMD', sep: '/', label: 'YYYY/MM/DD' },
  '6': { order: 'YMD', sep: '-', label: 'YYYY-MM-DD' },
};

/**
 * A date for a DTP filter in the logon user's format. BW reads the selection of a DATS field in
 * the user's external format and stores "#" for anything else, without an error; so YYYYMMDD and
 * YYYY-MM-DD are converted here, and a value in another form is passed on as it is.
 */
export function externalDate(value: string, datfm: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > days) {
    throw new ToolError('validation', `${value} is not a valid date.`, 'Give dates as YYYYMMDD or YYYY-MM-DD, e.g. 20261231.');
  }
  const f = DATE_FORMATS[datfm.trim()];
  if (!f) throw new ToolError('validation', `The date format of the logon user (USR01-DATFM "${datfm}") is not supported for DTP filters.`, 'Give the date as BW shows it in bw_read(type="DTPA", part="filter").');
  const parts = f.order === 'DMY' ? [d, mo, y] : f.order === 'MDY' ? [mo, d, y] : [y, mo, d];
  return parts.join(f.sep);
}

const userDateFormat = new WeakMap<BwClient, Promise<string | undefined>>();

/** USR01-DATFM of the logon user (cached per client), or undefined when it cannot be read. */
async function dateFormatOf(client: BwClient): Promise<string | undefined> {
  let p = userDateFormat.get(client);
  if (!p) {
    p = (async () => {
      try {
        const { queryTable } = await import('../legacy/metadata_sql.js');
        const rows = await queryTable(client, 'SELECT bname, datfm FROM usr01 WHERE bname = @sy-uname', 1);
        return rows.length ? String(rows[0].DATFM ?? '1').trim() || '1' : undefined;
      } catch {
        return undefined;
      }
    })();
    userDateFormat.set(client, p);
  }
  return p;
}

/**
 * Data types (DATS, TIMS, CHAR, …) of the DTP's filter fields, taken from its source: the field
 * or InfoObject element of the provider or DataSource, else the InfoObject itself.
 */
async function filterFieldTypes(client: BwClient, info: DtpInfo, dtpXml: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const src = info.source;
  const t = src.type.toUpperCase();
  const byName = new Map<string, string>();
  try {
    let path: string | undefined;
    if (t === 'ADSO' || t === 'HCPR' || t === 'TRCS') path = `/sap/bw/modeling/${t.toLowerCase()}/${bwSeg(src.name.toLowerCase())}/m`;
    if (t === 'RSDS') {
      const ds = splitDataSource(t, src.name);
      if (ds.sourceSystem) path = `/sap/bw/modeling/rsds/${bwSeg(ds.name.toLowerCase())}/${ds.sourceSystem.toUpperCase()}/m`;
    }
    if (path) {
      const doc = (await freshRead(path, MEDIA_TYPES[t.toLowerCase()])).body;
      for (const m of doc.matchAll(/<(element|field)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
        const type = attr(startTag(m[3], 'inlineType'), 'name');
        if (!type) continue;
        for (const k of [attr(`<x ${m[2]}>`, 'name'), attr(`<x ${m[2]}>`, 'infoObjectName')]) if (k && !byName.has(k.toUpperCase())) byName.set(k.toUpperCase(), type.toUpperCase());
      }
    }
  } catch {
    /* types stay unknown; values then go to BW as given */
  }
  for (const f of info.filterFields) {
    const block = new RegExp(`<fields\\b[^>]*\\sname="${f.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[\\s\\S]*?</fields>`).exec(dtpXml)?.[0] ?? '';
    const iobj = attr(startTag(block, 'infoObject'), 'name');
    const n = f.name.toUpperCase();
    const candidates = [f.dtaName.split('-').pop() ?? '', n, n.replace(/^\/BIC\//, ''), `0${n}`, iobj ?? ''].map((c) => c.toUpperCase()).filter(Boolean);
    let type = candidates.map((c) => byName.get(c)).find(Boolean);
    if (!type && iobj) {
      const doc = await freshRead(`/sap/bw/modeling/iobj/${bwSeg(iobj.toLowerCase())}/m`, MEDIA_TYPES['iobj']).then((r) => r.body, () => '');
      type = /<dataType>([^<]+)<\/dataType>/.exec(doc)?.[1]?.toUpperCase();
    }
    if (type) out.set(n, type);
  }
  return out;
}

const DATE_LIKE = /^\d{8}$|^\d{4}-\d{2}-\d{2}$/;

async function filterChanges(client: BwClient, name: string, filters: FilterSpec[], current: DtpInfo, dtpXml: string, transport?: string): Promise<string[]> {
  const notes: string[] = [];
  const available = current.filterFields.map((x) => x.name);
  // Dates go to BW in the logon user's format; the types are read only when a value looks like one.
  const datelike = filters.some((f) => f.selections.some((x) => x.operator !== 'ContainsPattern' && (DATE_LIKE.test(x.low) || DATE_LIKE.test(x.high ?? ''))));
  const types = datelike ? await filterFieldTypes(client, current, dtpXml) : new Map<string, string>();
  const written: { field: string; selections: FilterSpec['selections'] }[] = [];
  for (const f of filters) {
    const field = dtpField(f.field, available);
    let selections = f.selections;
    if (types.get(field) === 'DATS' && selections.some((x) => x.operator !== 'ContainsPattern' && (DATE_LIKE.test(x.low) || DATE_LIKE.test(x.high ?? '')))) {
      const datfm = await dateFormatOf(client);
      if (datfm === undefined) {
        throw new ToolError('validation', `Filter ${f.field}: the date format of the logon user could not be read (USR01 through ADT DataPreview).`, 'Give the dates in the format BW shows in bw_read(type="DTPA", part="filter"), e.g. 31.12.2026.');
      }
      const conv = (v: string) => {
        try {
          return externalDate(v, datfm);
        } catch (e) {
          if (e instanceof ToolError) throw new ToolError('validation', `Filter ${f.field}: ${e.message}`, e.hint);
          throw e;
        }
      };
      selections = selections.map((x) => (x.operator === 'ContainsPattern' ? x : { ...x, low: conv(x.low), ...(x.high !== undefined ? { high: conv(x.high) } : {}) }));
    }
    const now = current.filterFields.find((x) => x.name.toUpperCase() === field);
    if (selectionKey(now?.selections ?? []) === selectionKey(selections)) continue;
    const res = JSON.parse(
      await bwUpdateDtp(client, {
        dtp_name: name,
        ...(selections.length > 0 ? { filter_field: field, filter_selections: selections } : { filter_clear_fields: field }),
        transport,
      }),
    ) as { success?: boolean; message?: string };
    if (res.success === false) throw new ToolError('validation', `Filter ${f.field}: ${res.message ?? 'refused'}`, 'bw_read(type="DTPA", part="filter") lists the filter fields.');
    notes.push(`filter ${f.field}`);
    if (selections.length > 0) written.push({ field, selections });
  }
  if (written.length) {
    // BW accepts a value it cannot read without an error and stores "#" or nothing: read back.
    const after = parseDtpXml((await readDoc(name)).xml, 'unknown');
    for (const w of written) {
      const stored = after.filterFields.find((x) => x.name.toUpperCase() === w.field)?.selections ?? [];
      // "#" is how BW shows the initial value, so only count the values that are not initial.
      const filled = (vals: (string | undefined)[]) => vals.filter((v) => v !== undefined && v !== '' && v !== '#').length;
      const lost =
        stored.length !== w.selections.length ||
        filled(stored.flatMap((x) => [x.low, x.high])) < filled(w.selections.flatMap((x) => [x.low, x.high]));
      if (lost) {
        const shown = stored.map((x) => `${x.operator.toLowerCase()} ${x.low}${x.operator === 'Between' ? `..${x.high}` : ''}`).join(', ') || 'nothing';
        const known = types.size ? types : await filterFieldTypes(client, current, dtpXml);
        const date = known.get(w.field) === 'DATS';
        throw new ToolError(
          'validation',
          `Filter ${w.field}: BW did not take the values (stored: ${shown}). The DTP is saved with this filter.`,
          date ? 'Give dates as YYYYMMDD (e.g. 20261231): the server converts them to the date format of the logon user and checks them.' : 'Give the values as BW shows them in bw_read(type="DTPA", part="filter"); fix the filter with the next bw_write.',
        );
      }
    }
  }
  return notes;
}

/** Routine code compared line by line, ignoring trailing blanks and empty lines. */
export function sameCode(stored: string[], given: string): boolean {
  const norm = (lines: string[]) => lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.trimEnd()).filter((l) => l !== '');
  return norm(stored).join('\n') === norm([given]).join('\n');
}

function isTechnicalName(name: string): boolean {
  return /^DTP_[A-Z0-9]+$/.test(name);
}

export const dtpaAdapter: ObjectAdapter = {
  ...dtpaReader,
  activationType: 'dtpa',

  describe(action) {
    return (
      action === 'create'
        ? [
            'DTPA create spec (omit name: BW generates it; the result line reports it)',
            '  source       {type, name, source_system}   ADSO | HCPR | RSDS | TRCS | IOBJ  (required)',
            '               source_system only for RSDS',
            '  target       {type, name}                                                (required)',
            '  description  text, max 60',
            '  mode         full | delta (BW default when omitted)',
            '  filter       list per source field, either',
            '                 {field, values, exclude}      values to include (exclude=true: to exclude)',
            '                 {field, selections}           list of {op, low, high, exclude}; op eq (default) |',
            '                                               ne | between (with high) | pattern (* wildcard) |',
            '                                               gt | ge | lt | le; low "" = initial value (eq, ne)',
            '               dates as YYYYMMDD (e.g. 20261231), times as HHMMSS; the server writes them',
            '               in the user\'s format and checks that BW kept them',
            '  semantic_group  source fields that form the semantic group',
            'The transformation from source to target must exist (or be created in the same call);',
            'a chain through one InfoSource is found as well. A create for source and target that',
            'already have a DTP updates that DTP instead. The DTP is activated in the same call.',
            'Examples',
            '  {"action":"create","type":"DTPA","spec":{"source":{"type":"ADSO","name":"ZSALES01"},"target":{"type":"ADSO","name":"ZSALES02"},"mode":"delta"}}',
            '  {"action":"create","type":"DTPA","spec":{"source":{"type":"RSDS","name":"ZDS_SALES","source_system":"SELF"},"target":{"type":"ADSO","name":"ZSALES01"},"filter":[{"field":"BUKRS","values":["1000","2000"]}]}}',
          ]
        : [
            'DTPA update spec (name = DTP_..., or omit name and use action create)',
            '  description  text, max 60',
            '  mode         full | delta',
            '  filter       as in create; the list of a field replaces its filter, values [] clears it',
            '  semantic_group  complete list of fields; [] removes the semantic group',
            '  filter_routine  {field, code, global_code}: ABAP filter routine of one source field;',
            '               code = the routine body (no FORM/ENDFORM), global_code = global declarations.',
            '               Generated, activated and attached in the same call.',
            'Example',
            '  {"action":"update","type":"DTPA","name":"DTP_0UAXC2MML6TBRICFAG4MCU6F4","spec":{"mode":"delta"}}',
            '  {"action":"update","type":"DTPA","name":"DTP_0UAXC2MML6TBRICFAG4MCU6F4","spec":{"filter":[{"field":"FLDATE","selections":[{"op":"between","low":"20260101","high":"20261231"}]},{"field":"CARRID","values":["XX"],"exclude":true}]}}',
          ]
    ).join('\n');
  },

  check(action: WriteAction, _name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    checkFilters(s.filter, errors);
    if (action === 'create') {
      const src = flowEnd(s.source);
      if (src.type === 'RSDS' && !src.sourceSystem) errors.push('source.source_system: required for a DataSource');
      if (src.type !== 'RSDS' && src.sourceSystem) errors.push('source.source_system: only for a DataSource');
    }
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action !== 'create' || !spec) return [];
    const src = flowEnd(spec.source);
    const tgt = flowEnd(spec.target);
    return [
      { type: src.type, name: src.name },
      { type: tgt.type, name: tgt.name },
      { type: 'TRFN', name: flowIdentity(src, tgt).toUpperCase() },
    ] as ObjectRef[];
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
    if (isTechnicalName(name)) return dtpaReader.locate(client, name);
    const wanted = parseIdentity(name);
    if (!wanted) return { exists: false };
    for (const h of await xref(client, wanted.target.type, wanted.target.name, wanted.target.sourceSystem)) {
      if (h.type !== 'DTPA') continue;
      const { xml } = await readDoc(h.name);
      const e = ends(xml);
      if (sameEnd(e.source, wanted.source) && sameEnd(e.target, wanted.target)) return { ...locationFromXml(xml), name: h.name.toUpperCase() };
    }
    return { exists: false };
  },

  async create(_name, spec, ctx) {
    const src = flowEnd(spec.source);
    const tgt = flowEnd(spec.target);
    const chain = await chainSettled(ctx.client, src, tgt);
    const filters = filtersOf(spec).filter((f) => f.selections.length > 0);
    const res = JSON.parse(
      await bwCreateDtp(ctx.client, {
        trfn_name: chain[0],
        trfn_name_2: chain[1],
        source_name: src.name,
        source_type: src.type,
        source_system: src.sourceSystem,
        target_name: tgt.name,
        target_type: tgt.type,
        description: typeof spec.description === 'string' ? spec.description : undefined,
        package: ctx.package,
      }),
    ) as { success?: boolean; message?: string; dtp_name?: string };
    if (!res.dtp_name) throw new ToolError('backend', res.message ?? 'DTP was not created');
    const name = res.dtp_name.toUpperCase();
    const notes = [chain.length > 1 ? `via TRFN ${chain[0]} and ${chain[1]}` : `via TRFN ${chain[0]}`];
    // Filters follow the create: only the saved DTP names its filter fields.
    const created = await readDoc(name);
    const info = parseDtpXml(created.xml, created.status);
    notes.push(...(await filterChanges(ctx.client, name, filters, info, created.xml, ctx.transport)));
    if (spec.mode) {
      if ((spec.mode === 'delta') !== (info.extractionMode === 'D')) {
        await bwUpdateDtp(ctx.client, { dtp_name: name, extraction_mode: spec.mode as 'full' | 'delta', transport: ctx.transport });
      }
      notes.push(String(spec.mode));
    }
    if (Array.isArray(spec.semantic_group)) {
      const group = (spec.semantic_group as unknown[]).map((g) => String(g).toUpperCase());
      const own = group.map((g) => dtpField(g, info.semanticGroupFields.map((f) => f.name)));
      const res = JSON.parse(await bwUpdateDtp(ctx.client, { dtp_name: name, semantic_group_fields: own.join(','), transport: ctx.transport })) as { success?: boolean; message?: string };
      if (res.success === false) throw new ToolError('validation', `Semantic group: ${res.message ?? 'refused'}`, 'bw_read(type="DTPA", detail="full") lists the fields of the semantic group.');
      notes.push(`semantic group ${group.join('+') || 'none'}`);
    }
    const { xml } = await readDoc(name);
    const active = objectStatus(xml) === 'active';
    return active ? { status: 'created', name, activated: true, notes } : { status: 'created', name, activation: { lockHandle: '' }, notes };
  },

  async update(name, spec, ctx) {
    const { xml, status } = await readDoc(name);
    const info = parseDtpXml(xml, status);
    const notes: string[] = [];
    const args: Parameters<typeof bwUpdateDtp>[1] = { dtp_name: name, transport: ctx.transport };
    if (typeof spec.description === 'string' && spec.description !== xmlDecode(info.description)) {
      args.description = spec.description;
      notes.push('description');
    }
    if (spec.mode && (spec.mode === 'delta') !== (info.extractionMode === 'D')) {
      args.extraction_mode = spec.mode as 'full' | 'delta';
      notes.push(String(spec.mode));
    }
    if (Array.isArray(spec.semantic_group)) {
      const group = (spec.semantic_group as unknown[]).map((g) => String(g).toUpperCase());
      const own = group.map((g) => dtpField(g, info.semanticGroupFields.map((f) => f.name)));
      const now = info.semanticGroupFields.filter((f) => f.isKey).map((f) => f.name.toUpperCase());
      if ([...own].sort().join(',') !== [...now].sort().join(',')) {
        args.semantic_group_fields = own.join(',');
        notes.push(`semantic group ${group.join('+') || 'none'}`);
      }
    }
    if (notes.length > 0) {
      const res = JSON.parse(await bwUpdateDtp(ctx.client, args)) as { success?: boolean; message?: string };
      if (res.success === false) throw new ToolError('backend', res.message ?? 'DTP update failed');
    }
    notes.push(...(await filterChanges(ctx.client, name, filtersOf(spec), info, xml, ctx.transport)));
    const fr = spec.filter_routine as JsonObject | undefined;
    const frField = fr ? dtpField(String(fr.field), info.filterFields.map((x) => x.name)) : '';
    const frNow = info.filterFields.find((x) => x.name.toUpperCase() === frField);
    const sameRoutine =
      fr !== undefined &&
      frNow?.hasRoutine === true &&
      sameCode(frNow.routineCode, String(fr.code)) &&
      (typeof fr.global_code !== 'string' || sameCode(info.globalRoutineCode, fr.global_code));
    if (fr && !sameRoutine) {
      const text = await bwSetDtpFilterRoutine(ctx.client, {
        dtp_name: name.toUpperCase(),
        field_name: frField,
        routine_code: String(fr.code),
        ...(typeof fr.global_code === 'string' ? { global_code: fr.global_code } : {}),
      });
      try {
        const r = JSON.parse(text) as { success?: boolean; message?: string };
        if (r.success === false) throw new ToolError('validation', `filter routine: ${r.message ?? 'refused'}`);
      } catch (err) {
        if (err instanceof ToolError) throw err;
      }
      notes.push(`filter routine on ${String(fr.field).toUpperCase()}`);
    }
    if (notes.length === 0) return { status: 'unchanged' };
    const after = await readDoc(name);
    return objectStatus(after.xml) === 'active' ? { status: 'changed', activated: true, notes } : { status: 'changed', activation: { lockHandle: '' }, notes };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'dtpa', name);
    return { status: 'deleted' };
  },
};
