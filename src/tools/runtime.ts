/**
 * bw_data, bw_monitor, bw_run and bw_transport: reading data, watching loads and chains,
 * runtime actions and transports.
 *
 * The BW paths live in src/legacy/ (reporting, request_monitor,
 * process_chain_monitor, process_chain_run, remodeling, push, cto, transport, query_statistics).
 * What these handlers add:
 *
 *   - bw_data(action="query") takes characteristics and filters by name, in the selection
 *     format of every other coBWeb spec; the session ids the reporting endpoint needs are read
 *     from a first, metadata-only call. Names that do not exist are refused with the list.
 *   - Runtime actions and transport changes are checked against the allowed InfoAreas and
 *     packages, as every write is.
 */
import type { BwClient } from '../bw/client.js';
import { isBwType, type BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import { bwChangePackage, bwListChangeableTransports } from '../legacy/cto.js';
import { bwPreviewDatasource } from '../legacy/datasource.js';
import { bwRunDtp } from '../legacy/dtp.js';
import { bwMoveObject } from '../legacy/infoarea.js';
import { bwGetProcessChainRunDetail, bwListProcessChainLastStatus, bwListProcessChainRuns } from '../legacy/process_chain_monitor.js';
import { bwStartProcessChain } from '../legacy/process_chain_run.js';
import { bwPushData } from '../legacy/push.js';
import { bwQueryStatistics } from '../legacy/query_statistics.js';
import { bwGetRemodelingRequest, bwListRemodelingRequests, bwRunRemodeling, type RemodelingAction } from '../legacy/remodeling.js';
import { bwGetFilterValues, bwQueryData, parseMetaData, parseVariablesContainer, type DrillOperation, type InfoObjectState, type VariableInput } from '../legacy/reporting.js';
import { bwActivateRequest, bwDeleteRequest, bwGetRequest, bwListRequests } from '../legacy/request_monitor.js';
import { bwCreateTransportTask } from '../legacy/transport.js';
import { READERS } from '../objects/registry.js';
import { matchesAny } from '../policy/policy.js';
import type { HandlerContext } from './context.js';

type Rec = Record<string, unknown>;
type FilterValue = NonNullable<InfoObjectState['filterValues']>[number];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const up = (v: unknown) => str(v)?.toUpperCase();
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function need(args: JsonObject, key: string, what: string): string {
  const v = str(args[key]);
  if (!v) throw new ToolError('validation', `${what} needs ${key}.`);
  return v;
}

// ── Boundaries ────────────────────────────────────────────────────────────────

/** Refuses an action on an object outside the allowed InfoAreas or packages. */
async function inBounds(ctx: HandlerContext, client: BwClient, type: BwType, name: string, sourceSystem?: string): Promise<void> {
  const reader = READERS[type];
  if (!reader) return;
  const loc = await reader.locate(client, name, sourceSystem);
  if (!loc.exists) throw new ToolError('not_found', `${type} ${name} not found.`);
  if (loc.infoArea && !matchesAny(ctx.config.allowedInfoAreas, loc.infoArea)) {
    throw new ToolError('not_allowed', `${type} ${name} is in InfoArea ${loc.infoArea}, which this server may not change.`, 'Ask the administrator (COBWEB_ALLOWED_INFOAREAS).');
  }
  if (loc.package && !matchesAny(ctx.config.allowedPackages, loc.package)) {
    throw new ToolError('not_allowed', `${type} ${name} is in package ${loc.package}, which this server may not change.`, 'Ask the administrator (COBWEB_ALLOWED_PACKAGES).');
  }
}

// ── bw_data ───────────────────────────────────────────────────────────────────

const OP: Record<string, { op: string; sign?: 'E' }> = { eq: { op: 'EQ' }, ne: { op: 'EQ', sign: 'E' }, between: { op: 'BT' }, gt: { op: 'GT' }, ge: { op: 'GE' }, lt: { op: 'LT' }, le: { op: 'LE' } };

/** One filter entry in the coBWeb selection format → filter values of the reporting state. */
export function filterValues(f: Rec): FilterValue[] {
  const internal = f['internal'] === true;
  const key = (v: unknown) => (internal ? { lowInt: String(v) } : { low: String(v) });
  const out: FilterValue[] = [];
  const exclude = f['exclude'] === true;
  for (const v of (f['values'] as unknown[] | undefined) ?? []) out.push({ ...key(v), op: 'EQ', sign: exclude ? 'E' : 'I' });
  for (const s of (f['selections'] as Rec[] | undefined) ?? []) {
    const op = OP[String(s['op'] ?? 'eq').toLowerCase()];
    if (!op) throw new ToolError('validation', `filter ${f['field']}: op ${s['op']} is not one of ${Object.keys(OP).join(', ')}.`);
    const excl = (op.sign === 'E') !== (s['exclude'] === true);
    out.push({ ...key(s['low']), ...(s['high'] !== undefined ? { high: String(s['high']) } : {}), op: op.op, sign: excl ? 'E' : 'I' });
  }
  for (const n of (f['nodes'] as unknown[] | undefined) ?? []) out.push({ lowInt: String(n), op: 'EQ', sign: exclude ? 'E' : 'I', nodeId: 1, nodeType: '0HIER_NODE' });
  if (!out.length) throw new ToolError('validation', `filter ${f['field']}: give values, selections or nodes.`);
  return out;
}

/** Variable values: "A", "A..B" (interval) or "A,B" (several). */
export function variableValues(v: string): VariableInput['values'] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const range = x.match(/^(.+?)\.\.(.+)$/);
      return range ? { low: range[1], high: range[2], op: 'BT', sign: 'I' } : { low: x, op: 'EQ', sign: 'I' };
    });
}

/** The reporting state for the axes and filters asked for, built from the metadata of a first call. */
/**
 * The drill operation that collapses (or expands) a hierarchy node of the result: the node by
 * key or text, on the row or the column axis, with its tuple and element position.
 */
export function findDrill(raw: string, node: string, collapse: boolean): DrillOperation {
  const want = collapse ? '3' : '2';
  const seen: string[] = [];
  for (const axis of ['ROWS', 'COLUMNS'] as const) {
    const tag = axis.toLowerCase();
    const section = new RegExp(`<resultSet\\b[\\s\\S]*?<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(raw)?.[1] ?? '';
    const tuples = /<tuples\b[^>]*>([\s\S]*?)<\/tuples>/.exec(section)?.[1] ?? '';
    let ti = 0;
    for (const t of tuples.matchAll(/<tuple\b[^>]*>([\s\S]*?)<\/tuple>/g)) {
      let ei = 0;
      for (const v of t[1].matchAll(/<value\b([^>]*?)\/?>/g)) {
        const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(v[1])?.[1] ?? '';
        const st = a('drillSt');
        if (st === '2' || st === '3') {
          const keys = [a('intKey'), a('extKey'), xmlDecode(a('txt'))].map((x) => x.trim().toUpperCase());
          if (st === want && keys.includes(node.trim().toUpperCase())) return { axis, drill_state: collapse ? 2 : 3, tuple_idx: ti + 1, element_idx: ei + 1 };
          seen.push(`${xmlDecode(a('txt')) || a('intKey')} (${st === '3' ? 'expanded' : 'collapsed'})`);
        }
        ei++;
      }
      ti++;
    }
  }
  throw new ToolError(
    'validation',
    `No ${collapse ? 'expanded' : 'collapsed'} hierarchy node ${node} in the result.`,
    seen.length ? `Nodes: ${[...new Set(seen)].join(', ')}.` : 'The result shows no hierarchy; the display hierarchy comes from the query definition.',
  );
}

const xmlDecode = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function buildState(metaXml: string, args: JsonObject): { state?: { infoObjects: InfoObjectState[] }; variables?: VariableInput[] } {
  const md = parseMetaData(metaXml);
  const chars = md?.characteristics ?? [];
  const find = (name: string) => chars.find((c) => c.name.toUpperCase() === name.toUpperCase()) ?? chars.find((c) => c.txt.toUpperCase() === name.toUpperCase());
  const rows = ((args['rows'] as string[] | undefined) ?? []).map(String);
  const columns = ((args['columns'] as string[] | undefined) ?? []).map(String);
  const filters = (args['filter'] as Rec[] | undefined) ?? [];
  const unknown = [...rows, ...columns, ...filters.map((f) => String(f['field'] ?? ''))].filter((n) => !find(n));
  if (unknown.length) {
    throw new ToolError(
      'validation',
      `Not in this query or provider: ${[...new Set(unknown)].join(', ')}.`,
      `Characteristics: ${chars.map((c) => `${c.name}${c.isStructure === 'true' ? ' (structure)' : ''}`).join(', ') || 'none'}.`,
    );
  }
  const layout = rows.length > 0 || columns.length > 0;
  let state: { infoObjects: InfoObjectState[] } | undefined;
  if (layout || filters.length) {
    state = {
      infoObjects: chars.map((c) => {
        const inRows = rows.some((r) => find(r) === c);
        const inCols = columns.some((r) => find(r) === c);
        const axis = inRows ? 'ROWS' : inCols ? 'COLUMNS' : layout && c.isStructure !== 'true' ? 'FREE' : c.axis || 'FREE';
        const fv = filters.filter((f) => find(String(f['field'])) === c).flatMap(filterValues);
        return { name: c.name, id: c.id, axis, ...(fv.length ? { filterValues: fv } : {}) };
      }),
    };
  }
  const given = (args['variables'] as Record<string, unknown> | undefined) ?? {};
  let variables: VariableInput[] | undefined;
  if (Object.keys(given).length) {
    const vc = parseVariablesContainer(metaXml);
    const vars = vc?.variables ?? [];
    // BW names a variable "ZV_NAME<blanks><number>"; the first word is the technical name.
    const vname = (v: { name: string }) => v.name.trim().split(/\s+/)[0].toUpperCase();
    const missing = Object.keys(given).filter((k) => !vars.some((v) => vname(v) === k.toUpperCase()));
    if (missing.length) throw new ToolError('validation', `Variables not in this query: ${missing.join(', ')}.`, `Variables: ${vars.map(vname).join(', ') || 'none'}.`);
    variables = vars
      .filter((v) => Object.keys(given).some((k) => k.toUpperCase() === vname(v)))
      .map((v) => {
        const raw = Object.entries(given).find(([k]) => k.toUpperCase() === vname(v))![1];
        return {
          name: v.name,
          id: v.id,
          ...(v.txt ? { txt: v.txt } : {}),
          ...(v.altName ? { altName: v.altName } : {}),
          ...(v.iobj ? { iobj: v.iobj } : {}),
          inputEnabled: v.inputEnabled !== 'false',
          ...(v.mandatory ? { mandatory: v.mandatory === 'true' } : {}),
          values: variableValues(Array.isArray(raw) ? raw.join(',') : String(raw)),
        };
      });
  }
  return { state, variables };
}

/** A list given as an array or as comma-separated text. */
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

async function queryData(client: BwClient, args: JsonObject): Promise<string> {
  const name = need(args, 'source', 'bw_data(action="query")').toUpperCase();
  // A query, else an InfoProvider read directly.
  const isQuery = await READERS.QUERY!.locate(client, name).then((l) => l.exists, () => false);
  const offset = num(args['offset'], 0);
  const max = num(args['max_rows'], 100);
  const stats = args['with_statistics'] === true;
  const drills = [
    ...list(args['collapse']).map((node) => ({ node, collapse: true })),
    ...list(args['expand']).map((node) => ({ node, collapse: false })),
  ];
  const asked = drills.length > 0 || ['rows', 'columns', 'filter'].some((k) => Array.isArray(args[k]) && (args[k] as unknown[]).length > 0) || (args['variables'] && Object.keys(args['variables'] as Rec).length > 0);
  const words = (text: string) => text.replace(/from_row=(\d+)/g, 'offset=$1').replace(/bw_get_filter_values/g, 'bw_data(action="values")');
  if (!asked) return words(await bwQueryData(client, name, !isQuery, 'text', undefined, undefined, offset, offset + max, undefined, stats));
  const meta = await bwQueryData(client, name, !isQuery, 'raw', undefined, undefined, 0, 1);
  const { state, variables } = buildState(meta, args);
  // Each drill step is found in the result of the steps before it: a collapsed node moves
  // the tuples below it.
  const ops: DrillOperation[] = [];
  for (const d of drills) {
    const raw = await bwQueryData(client, name, !isQuery, 'raw', state, variables, 0, 10000, ops.length ? ops : undefined);
    ops.push(findDrill(raw, d.node, d.collapse));
  }
  return words(await bwQueryData(client, name, !isQuery, 'text', state, variables, offset, offset + max, ops.length ? ops : undefined, stats));
}

export async function bwData(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const client = ctx.client() as unknown as BwClient;
  switch (args['action']) {
    case 'query':
      return queryData(client, args);
    case 'preview': {
      const name = need(args, 'source', 'preview').toUpperCase();
      const ss = need(args, 'source_system', 'preview of a DataSource').toUpperCase();
      return bwPreviewDatasource(client, name, ss, num(args['max_rows'], 20));
    }
    case 'values':
      return bwGetFilterValues(client, need(args, 'source', 'values').toUpperCase(), str(args['search']) ?? '*', up(args['provider']), num(args['max_rows'], 201));
    default:
      throw new ToolError('validation', `Unknown action ${String(args['action'])}.`);
  }
}

// ── bw_monitor ────────────────────────────────────────────────────────────────

export async function bwMonitor(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const client = ctx.client() as unknown as BwClient;
  const name = up(args['name']);
  const id = str(args['id']);
  const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;
  const since = str(args['since']);
  const until = str(args['until']);
  const status = str(args['status']);
  switch (args['what']) {
    case 'chain_status':
      return bwListProcessChainLastStatus(client, status, since, until, limit);
    case 'chain_runs':
      return bwListProcessChainRuns(client, name, since, until, status, limit ?? 20);
    case 'chain_run':
      return bwGetProcessChainRunDetail(client, need(args, 'name', 'chain_run').toUpperCase(), need(args, 'id', 'chain_run (the run log id)'), args['detail'] === 'full');
    case 'requests':
      return bwListRequests(client, need(args, 'name', 'requests (the target)').toUpperCase(), up(args['target_type']) ?? 'ADSO', str(args['storage']) ?? 'AQ,AX,AT', status ?? 'N,GG,GR,YG,RR,YR,RG,U,Y,X', limit ?? 3, since);
    case 'request':
      return bwGetRequest(client, need(args, 'id', 'request (the request TSN)'), str(args['storage']) ?? 'AQ', args['detail'] === 'raw' ? 'raw' : 'text');
    case 'remodeling':
      return id
        ? bwGetRemodelingRequest(client, need(args, 'name', 'remodeling details (the InfoProvider)').toUpperCase(), id, str(args['request']), true, args['detail'] === 'raw' ? 'raw' : 'text')
        : bwListRemodelingRequests(client, name, status, limit ?? 20);
    case 'query_stats': {
      const target = need(args, 'name', 'query_stats (query or provider)').toUpperCase();
      const isQuery = await READERS.QUERY!.locate(client, target).then((l) => l.exists, () => false);
      return bwQueryStatistics(client, {
        ...(isQuery ? { query_name: target } : { provider: target }),
        ...(id ? { step_uid: id } : {}),
        ...(since ? { from: since } : {}),
        ...(until ? { to: until } : {}),
        ...(limit !== undefined ? { slowest: limit } : {}),
      });
    }
    default:
      throw new ToolError('validation', `Unknown what ${String(args['what'])}.`);
  }
}

// ── bw_run ────────────────────────────────────────────────────────────────────

/**
 * A legacy JSON answer as one line: the message, and what to do next when it says so; a
 * refusal as an error. Text answers pass unchanged.
 */
export function runAnswer(text: string, next?: string): string {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return text;
  if (r['success'] === false) throw new ToolError('backend', legacyRefusal(r));
  const parts = [typeof r['message'] === 'string' ? r['message'] : 'Done.'];
  if (typeof r['next_step'] === 'string') parts.push(r['next_step']);
  else if (next) parts.push(next);
  return parts.join(' ');
}

export async function bwRun(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const client = ctx.client() as unknown as BwClient;
  const action = String(args['action']);
  const name = need(args, 'name', `bw_run(action="${action}")`).toUpperCase();
  const id = str(args['id']);
  switch (action) {
    case 'run_dtp':
      await inBounds(ctx, client, 'DTPA', name);
      return runAnswer(await bwRunDtp(name));
    case 'start_chain':
      await inBounds(ctx, client, 'RSPC', name);
      return bwStartProcessChain(client, name, num(args['wait_seconds'], 0));
    case 'activate_request':
      await inBounds(ctx, client, 'ADSO', name);
      return runAnswer(await bwActivateRequest(need(args, 'id', 'activate_request (the request TSN)'), str(args['storage']) ?? 'AQ'));
    case 'delete_request': {
      const type = (up(args['target_type']) ?? 'ADSO') as BwType;
      if (!isBwType(type)) throw new ToolError('validation', `target_type ${type} is not a coBWeb type.`);
      await inBounds(ctx, client, type, name);
      if (!id && args['all_requests'] !== true) throw new ToolError('validation', 'delete_request needs id (the request TSN) or all_requests=true.');
      return runAnswer(await bwDeleteRequest(client, id, str(args['storage']) ?? 'AQ', name, type, args['all_requests'] === true));
    }
    case 'run_remodeling': {
      const mode = (str(args['mode']) ?? 'execute') as RemodelingAction;
      if (!['execute', 'restart', 'reset', 'reset_step'].includes(mode)) throw new ToolError('validation', 'mode for run_remodeling: execute, restart, reset or reset_step.');
      await inBounds(ctx, client, 'ADSO', name).catch(async (err) => {
        if (err instanceof ToolError && err.kind === 'not_found') return inBounds(ctx, client, 'HCPR', name);
        throw err;
      });
      return runAnswer(await bwRunRemodeling(client, mode, name, need(args, 'id', 'run_remodeling (the remodeling rule)'), str(args['request']), str(args['start']) ?? 'immediate'));
    }
    case 'push_data': {
      const records = args['records'];
      if (!Array.isArray(records) || !records.length) throw new ToolError('validation', 'push_data needs records: [{FIELD: value, …}].');
      const mode = str(args['mode']) ?? 'one_step';
      if (!['one_step', 'messaging'].includes(mode)) throw new ToolError('validation', 'mode for push_data: one_step or messaging.');
      await inBounds(ctx, client, 'ADSO', name);
      return runAnswer(
        await bwPushData(client, name, mapPushFields(await pushFields(client, name), records as Rec[]), mode),
        `A standard DataStore object keeps the request in the inbound table until it is activated: bw_monitor(what="requests", name="${name}") shows it, bw_run(action="activate_request") activates it.`,
      );
    }
    default:
      throw new ToolError('validation', `Unknown action ${action}.`);
  }
}

// ── push ──────────────────────────────────────────────────────────────────────

export interface PushField {
  field: string;
  title: string;
  type: string;
  description: string;
  required: boolean;
}

/** The fields of an ADSO's write interface, from its JSON schema. */
export function parsePushSchema(text: string): PushField[] {
  const json = text.slice(text.indexOf('{'));
  const schema = JSON.parse(json) as { items?: { properties?: Record<string, Rec>; required?: string[] } };
  const req = new Set(schema.items?.required ?? []);
  return Object.entries(schema.items?.properties ?? {}).map(([field, p]) => ({
    field,
    title: String(p['title'] ?? ''),
    type: String(p['type'] ?? ''),
    description: String(p['description'] ?? '').replace(/^Datatype /, ''),
    required: req.has(field),
  }));
}

async function pushFields(client: BwClient, adso: string): Promise<PushField[]> {
  const { bwGetPushSchema } = await import('../legacy/push.js');
  return parsePushSchema(await bwGetPushSchema(client, adso));
}

/** Record keys as the write interface names them: InfoObject names get their /BIC/ prefix. */
export function mapPushFields(fields: PushField[], records: Rec[]): Rec[] {
  const byName = new Map<string, string>();
  for (const f of fields) {
    byName.set(f.field.toUpperCase(), f.field);
    byName.set(f.field.replace(/^\/BIC\//, '').toUpperCase(), f.field);
  }
  const unknown = new Set<string>();
  const out = records.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => {
        const f = byName.get(k.toUpperCase());
        if (!f) unknown.add(k);
        return [f ?? k, v];
      }),
    ),
  );
  if (unknown.size) {
    throw new ToolError('validation', `Not fields of the write interface: ${[...unknown].join(', ')}.`, `Fields: ${fields.map((f) => f.field.replace(/^\/BIC\//, '')).join(', ')}.`);
  }
  return out;
}

/** part="push_schema": the fields of the write interface, one line each. */
export function summarizePushSchema(adso: string, fields: PushField[]): string {
  return [
    `Write interface of ${adso.toUpperCase()}: ${fields.length} fields (records take these names, InfoObject names without /BIC/ too; * = required)`,
    ...fields.map((f) => `  ${f.required ? '*' : ' '} ${f.field}  ${f.description}  "${f.title}"`),
  ].join('\n');
}

// ── bw_transport ──────────────────────────────────────────────────────────────

function objectsOf(args: JsonObject): Array<{ type: BwType; name: string; sourceSystem?: string }> {
  const list = (args['objects'] as Rec[] | undefined) ?? [];
  if (!list.length) throw new ToolError('validation', `${String(args['action'])} needs objects: [{type, name}].`);
  return list.map((o) => {
    const type = String(o['type'] ?? '').toUpperCase();
    if (!isBwType(type)) throw new ToolError('validation', `${type} is not a coBWeb type.`);
    return { type, name: String(o['name'] ?? '').trim().toUpperCase(), ...(up(o['source_system']) ? { sourceSystem: up(o['source_system']) } : {}) };
  });
}

export async function bwTransport(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const client = ctx.client() as unknown as BwClient;
  switch (args['action']) {
    case 'list':
      return bwListChangeableTransports(client, { ownOnly: args['all_users'] !== true, modifiableOnly: args['include_released'] !== true, includeObjects: args['with_objects'] === true });
    case 'create_task':
      return bwCreateTransportTask(client, { transportRequest: need(args, 'transport', 'create_task').toUpperCase(), user: need(args, 'user', 'create_task (the task owner)').toUpperCase() });
    case 'assign': {
      const pkg = need(args, 'package', 'assign').toUpperCase();
      if (!matchesAny(ctx.config.allowedPackages, pkg)) throw new ToolError('not_allowed', `Package ${pkg} is not one this server may write to.`, 'Ask the administrator (COBWEB_ALLOWED_PACKAGES).');
      const out: string[] = [];
      for (const o of objectsOf(args)) {
        try {
          await inBounds(ctx, client, o.type, o.name, o.sourceSystem);
          await bwChangePackage(client, { objectName: o.name, objectType: o.type, package: pkg, ...(str(args['transport']) ? { transport: up(args['transport']) } : {}), ...(o.sourceSystem ? { sourceSystem: o.sourceSystem } : {}) });
          out.push(`assigned  ${o.type} ${o.name} → package ${pkg}${str(args['transport']) ? `, transport ${up(args['transport'])}` : ''}`);
        } catch (err) {
          out.push(`failed    ${o.type} ${o.name}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      return out.join('\n');
    }
    case 'move': {
      const area = need(args, 'info_area', 'move').toUpperCase();
      if (!matchesAny(ctx.config.allowedInfoAreas, area)) throw new ToolError('not_allowed', `InfoArea ${area} is not one this server may write to.`, 'Ask the administrator (COBWEB_ALLOWED_INFOAREAS).');
      const out: string[] = [];
      for (const o of objectsOf(args)) {
        try {
          await inBounds(ctx, client, o.type, o.name, o.sourceSystem);
          await bwMoveObject(client, { objectType: o.type.toLowerCase(), objectName: o.name, targetInfoArea: area });
          out.push(`moved     ${o.type} ${o.name} → InfoArea ${area}`);
        } catch (err) {
          out.push(`failed    ${o.type} ${o.name}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      return out.join('\n');
    }
    default:
      throw new ToolError('validation', `Unknown action ${String(args['action'])}.`);
  }
}
