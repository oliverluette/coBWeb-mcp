/**
 * Process chains (type RSPC).
 *
 * Reading uses the modeling API (/sap/bw/modeling/rspc/<name>/m, JSON); writing and activation
 * use the BW/4HANA process chain API, whose proven paths are taken over in
 * src/legacy/processchain_write.ts. This adapter adds the coBWeb side:
 *
 *   - one declarative spec for create and update: the steps and the flow between them, in
 *     words instead of node indexes and status codes;
 *   - a read in the same words, so a chain can be read, edited and written back;
 *   - an update that keeps every step it still finds unchanged, node settings included
 *     (repeat, wait times, notifications), instead of rebuilding the chain from the spec;
 *   - the same spec again reports unchanged.
 */
import { bwSeg, stripInfoAreaSentinel, type BwClient } from '../bw/client.js';
import type { BwType } from '../catalog/types.js';
import { ToolError } from '../format/errors.js';
import { bwDelete } from '../legacy/delete.js';
import {
  BASE,
  DECISION_VARIANTS_BASE,
  INLINE_STEP_TYPES,
  activateChain,
  buildModelParts,
  parseActivateResponse,
  buildTriggerDetail,
  bwCreateDecisionVariant,
  bwCreateProcessChain,
  eventConfigFromDetail,
  refreshCsrf,
  resolveTransportHeader,
  type EdgeDef,
  type Step,
  type TriggerEventConfig,
} from '../legacy/processchain_write.js';
import { isNotFound, type ObjectAdapter, type ObjectRef, type ReadOptions, type Spec, type WriteAction } from './adapter.js';

type Rec = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const READ_ACCEPT = 'application/vnd.sap.bw4.modeling.processchain-v1_0_0+json';
const COLLECTOR_OF: Record<string, string> = { AND: 'AND', OR: 'OR', EXOR: 'XOR', XOR: 'XOR' };

// ── Spec form ─────────────────────────────────────────────────────────────────

/** A step in spec form: exactly one of dtp, activate, cleanup, program, collector, decision, type. */
export interface SpecStep {
  id: string;
  dtp?: string;
  activate?: string[];
  sequential?: boolean;
  fail_if_nothing_activated?: boolean;
  cleanup?: Array<{ datastore: string; action: string; all_requests?: boolean; keep_requests?: number; older_than_days?: number; package_size?: number }>;
  program?: string;
  variant?: string;
  synchronous?: boolean;
  local?: boolean;
  collector?: 'AND' | 'OR' | 'XOR';
  decision?: string;
  formula?: string;
  then?: string;
  else?: string;
  type?: string;
  description?: string;
}

export interface SpecEdge {
  from: string;
  to: string;
  /** success | error | always; omitted: success, or "neutral" out of the start and collectors. */
  on?: 'success' | 'error' | 'always';
  /** Branch of a decision step ("01" = then, "02" = else). */
  branch?: string;
}

export interface ChainSpec {
  description: string;
  info_area: string;
  start: 'immediate' | { event: string; parameter?: string; once?: boolean };
  steps: SpecStep[];
  flow: SpecEdge[];
}

const STEP_KEYS = ['dtp', 'activate', 'cleanup', 'program', 'collector', 'decision', 'type'] as const;
const STEP_FIELDS = new Set(['id', ...STEP_KEYS, 'sequential', 'fail_if_nothing_activated', 'variant', 'synchronous', 'local', 'formula', 'then', 'else', 'description']);

function kindOf(s: SpecStep): (typeof STEP_KEYS)[number] {
  const kinds = STEP_KEYS.filter((k) => (s as unknown as Rec)[k] !== undefined);
  if (kinds.length !== 1) throw new ToolError('validation', `step ${s.id ?? '?'} needs exactly one of ${STEP_KEYS.join(', ')} (has ${kinds.join(', ') || 'none'})`);
  return kinds[0];
}

/** What a step does, independent of its id: matches a spec step with a node of the chain. */
export function identity(s: SpecStep): string {
  const k = kindOf(s);
  const up = (x: unknown) => String(x ?? '').toUpperCase();
  switch (k) {
    case 'dtp':
      return `DTP:${up(s.dtp)}`;
    case 'activate':
      return `ACT:${[...(s.activate ?? [])].map(up).sort().join(',')}:${s.sequential === true}:${s.fail_if_nothing_activated === true}`;
    case 'cleanup':
      return `REM:${JSON.stringify((s.cleanup ?? []).map((c) => [up(c.datastore), up(c.action), c.all_requests === true, c.keep_requests ?? 0, c.older_than_days ?? 0, c.package_size ?? 0]))}`;
    case 'program':
      return `ABAP:${up(s.program)}:${up(s.variant)}:${s.synchronous !== false}:${s.local !== false}`;
    case 'collector':
      return `COLL:${up(s.collector)}`;
    case 'decision':
      return `DEC:${up(s.decision)}`;
    default:
      return `GEN:${up(s.type)}:${up(s.variant)}`;
  }
}

function inlineDetail(model: Any, variant: string): Any {
  return (model.aInlineVariant ?? []).find((v: Any) => v.sProcessVariant === variant)?.oDetail ?? {};
}

/** Node → spec step (without id). */
function nodeStep(model: Any, node: Any): Omit<SpecStep, 'id'> {
  const type = String(node.sProcessType ?? '').toUpperCase();
  const variant = String(node.sProcessVariant ?? '');
  if (type === 'DTP_LOAD') return { dtp: variant };
  if (type === 'ADSOACT') {
    const d = inlineDetail(model, variant);
    return {
      activate: (d.DATASTORES ?? []).map((x: Any) => String(x.DATASTORE)),
      ...(d.NOCONDENSE === true ? { sequential: true } : {}),
      ...(d.NOREQACTWARN === true ? { fail_if_nothing_activated: true } : {}),
    };
  }
  if (type === 'ADSOREM') {
    const d = inlineDetail(model, variant);
    return {
      cleanup: (d.DATASTORES ?? []).map((x: Any) => ({
        datastore: String(x.DATASTORE),
        action: String(x.ACTION ?? ''),
        ...(x.ALL_REQUESTS ? { all_requests: true } : {}),
        ...(Number(x.NUMBER_REQUESTS) ? { keep_requests: Number(x.NUMBER_REQUESTS) } : {}),
        ...(Number(x.NUMBER_DAYS) ? { older_than_days: Number(x.NUMBER_DAYS) } : {}),
        ...(Number(x.PACKAGE_SIZE) ? { package_size: Number(x.PACKAGE_SIZE) } : {}),
      })),
    };
  }
  if (type === 'ABAP') {
    const d = inlineDetail(model, variant);
    const program = String(d.PROGRAM?.[0]?.key ?? '');
    const v = d.VARIANT?.[0]?.key;
    return { program, ...(v ? { variant: String(v) } : {}), ...(d.X_SYNCHRON === '' ? { synchronous: false } : {}), ...(d.X_LOCAL === '' ? { local: false } : {}) };
  }
  if (COLLECTOR_OF[type]) return { collector: COLLECTOR_OF[type] as SpecStep['collector'] };
  if (type === 'DECISION') return { decision: variant };
  return { type, variant };
}

/** Node settings the spec does not carry; kept on update, shown on read. */
function nodeSettings(node: Any): string[] {
  const out: string[] = [];
  if (Number(node.iAutoRepeatCount)) out.push(`repeat ${node.iAutoRepeatCount}×${Number(node.iAutoRepeatWaitDuration) ? ` every ${node.iAutoRepeatWaitDuration} s` : ''}`);
  if (Number(node.iDebugWaitDuration)) out.push(`debug wait ${node.iDebugWaitDuration} s`);
  if (node.sNotificationSuccess) out.push('notification on success');
  if (node.sNotificationFailure) out.push('notification on failure');
  if (node.bSkipped === true) out.push('skipped');
  if (node.sExecutionOption) out.push(`execution option ${node.sExecutionOption}`);
  return out;
}

const SHORT: Record<string, string> = { dtp: 'D', activate: 'ACT', cleanup: 'CLEANUP', program: 'P', collector: '', decision: 'DECISION', type: '' };

/** The chain in spec form, plus the node index of each step id. */
export function modelToSpec(model: Any): { spec: ChainSpec; ids: Map<number, string>; settings: Map<string, string[]>; texts: Map<string, string>; branches: Map<string, string[]> } {
  const nodes: Any[] = model.aNode ?? [];
  const header = model.oHeader ?? {};
  const triggerIdx = nodes.findIndex((n) => n.sProcessType === 'TRIGGER');
  const ids = new Map<number, string>();
  const used = new Set<string>(['TRIGGER']);
  const counters = new Map<string, number>();
  const steps: SpecStep[] = [];
  const settings = new Map<string, string[]>();
  const texts = new Map<string, string>();
  const branchesOf = new Map<string, string[]>();
  // Steps in the order the chain runs them: breadth first from the start, then the rest.
  const next = new Map<number, number[]>();
  const sortedEdges = [...(model.aEdge ?? [])].sort((x: Any, y: Any) => String(x.sSubStatus ?? '').localeCompare(String(y.sSubStatus ?? '')) || (x.sStatus === 'negative' ? 1 : 0) - (y.sStatus === 'negative' ? 1 : 0));
  for (const e of sortedEdges) next.set(e.iNodeIndexFrom, [...(next.get(e.iNodeIndexFrom) ?? []), e.iNodeIndexTo]);
  const order: number[] = [];
  const queue = [triggerIdx];
  const seen = new Set<number>(queue);
  while (queue.length) {
    const i = queue.shift()!;
    if (i !== triggerIdx) order.push(i);
    for (const j of next.get(i) ?? []) if (!seen.has(j)) (seen.add(j), queue.push(j));
  }
  nodes.forEach((_n, i) => {
    if (!seen.has(i)) order.push(i);
  });
  order.forEach((i) => {
    const n = nodes[i];
    const s = nodeStep(model, n);
    const k = kindOf(s as SpecStep);
    // Short ids (D1, ACT1, AND1, …): the step line names the DTP or program anyway.
    let base = k === 'collector' ? String(s.collector) : k === 'type' ? String(s.type) : SHORT[k];
    const c = (counters.get(base) ?? 0) + 1;
    counters.set(base, c);
    base = `${base}${c}`;
    let id = base;
    for (let j = 2; used.has(id); j++) id = `${base}_${j}`;
    used.add(id);
    ids.set(i, id);
    steps.push({ id, ...s });
    const st = nodeSettings(n);
    if (st.length) settings.set(id, st);
    if (k === 'decision') {
      const branches = (n.aSocket ?? []).filter((x: Any) => x.sSubStatus && x.sSubStatus !== '00').map((x: Any) => `${x.sSubStatus} ${x.sDescription ?? ''}`.trim());
      if (branches.length) branchesOf.set(id, branches);
    }
    const text = String(n.sVariantDescription ?? '');
    if (text && text !== n.sProcessVariant && k !== 'collector') texts.set(id, text);
  });
  if (triggerIdx >= 0) ids.set(triggerIdx, 'TRIGGER');
  // Edges grouped per (from, to, branch): a positive and a negative edge make "always".
  const groups = new Map<string, { from: string; to: string; branch: string; statuses: Set<string> }>();
  for (const e of model.aEdge ?? []) {
    const from = ids.get(e.iNodeIndexFrom);
    const to = ids.get(e.iNodeIndexTo);
    if (!from || !to) continue;
    const branch = e.sSubStatus && e.sSubStatus !== '00' ? String(e.sSubStatus) : '';
    const key = `${from}>${to}>${branch}`;
    const g = groups.get(key) ?? { from, to, branch, statuses: new Set<string>() };
    g.statuses.add(String(e.sStatus ?? ''));
    groups.set(key, g);
  }
  const rank = new Map<string, number>([['TRIGGER', -1], ...steps.map((x, i) => [x.id, i] as [string, number])]);
  const grouped = [...groups.values()].sort((x, y) => (rank.get(x.from)! - rank.get(y.from)!) || x.branch.localeCompare(y.branch) || (rank.get(x.to)! - rank.get(y.to)!));
  const flow: SpecEdge[] = grouped.map((g) => {
    if (g.branch) return { from: g.from, to: g.to, branch: g.branch };
    const pos = g.statuses.has('positive');
    const neg = g.statuses.has('negative');
    const on = pos && neg ? 'always' : neg ? 'error' : undefined;
    return { from: g.from, to: g.to, ...(on ? { on } : {}) } as SpecEdge;
  });
  const trigger = triggerIdx >= 0 ? inlineDetail(model, nodes[triggerIdx].sProcessVariant) : {};
  const ev = eventConfigFromDetail(trigger);
  const start: ChainSpec['start'] = ev ? { event: ev.eventId, ...(ev.eventParameter && ev.eventParameter !== header.sProcessChainId ? { parameter: ev.eventParameter } : {}), ...(ev.onlyOnce ? { once: true } : {}) } : 'immediate';
  return {
    spec: { description: String(header.sDescription ?? ''), info_area: stripInfoAreaSentinel(String(header.sLocation ?? '')), start, steps, flow },
    ids,
    settings,
    texts,
    branches: branchesOf,
  };
}

/** Spec steps in the form of the legacy builder. */
function legacySteps(steps: SpecStep[]): Step[] {
  return steps.map((s): Step => {
    const id = s.id;
    switch (kindOf(s)) {
      case 'dtp':
        return { id, type: 'DTP_LOAD', dtp: String(s.dtp).toUpperCase(), ...(s.description ? { description: s.description } : {}) };
      case 'activate':
        return { id, type: 'ADSOACT', datastores: (s.activate ?? []).map((d) => d.toUpperCase()), requestsSequential: s.sequential === true, errorOnNonActivation: s.fail_if_nothing_activated === true };
      case 'cleanup':
        return {
          id,
          type: 'ADSOREM',
          remDatastores: (s.cleanup ?? []).map((c) => ({ datastore: c.datastore.toUpperCase(), action: c.action.toUpperCase(), allRequests: c.all_requests === true, numberRequests: c.keep_requests ?? 0, numberDays: c.older_than_days ?? 0, packageSize: c.package_size ?? 0 })),
        } as Step;
      case 'program':
        return { id, type: 'ABAP', program: String(s.program).toUpperCase(), ...(s.variant ? { variant: s.variant.toUpperCase() } : {}), synchronous: s.synchronous !== false, local: s.local !== false, ...(s.description ? { description: s.description } : {}) } as Step;
      case 'collector':
        return { id, type: String(s.collector).toUpperCase() as 'AND' | 'OR' | 'XOR' };
      case 'decision':
        return { id, type: 'DECISION', variant: String(s.decision).toUpperCase(), ...(s.description ? { description: s.description } : {}) };
      default:
        return { id, type: String(s.type).toUpperCase(), object: String(s.variant ?? '').toUpperCase(), ...(s.description ? { description: s.description } : {}) } as Step;
    }
  });
}

function legacyEdges(flow: SpecEdge[]): EdgeDef[] {
  const out: EdgeDef[] = [];
  for (const e of flow) {
    const base = { from: e.from, to: e.to };
    if (e.branch) out.push({ ...base, subStatus: e.branch });
    else if (e.on === 'always') out.push({ ...base, status: 'positive' }, { ...base, status: 'negative' });
    else if (e.on === 'error') out.push({ ...base, status: 'negative' });
    else if (e.on === 'success') out.push({ ...base, status: 'positive' });
    else out.push(base);
  }
  return out;
}

function triggerEventOf(start: ChainSpec['start'] | undefined): TriggerEventConfig | undefined {
  if (!start || start === 'immediate') return undefined;
  return { eventId: start.event.toUpperCase(), ...(start.parameter ? { eventParameter: start.parameter } : {}), ...(start.once ? { onlyOnce: true } : {}) };
}

/** Comparable form of a chain: step identities and the flow between them, ids left out. */
export function canonical(spec: Pick<ChainSpec, 'steps' | 'flow'>): string {
  const counts = new Map<string, number>();
  const idOf = new Map<string, string>([['TRIGGER', 'TRIGGER']]);
  for (const s of spec.steps) {
    const ident = identity(s);
    const n = (counts.get(ident) ?? 0) + 1;
    counts.set(ident, n);
    idOf.set(s.id.toUpperCase(), `${ident}#${n}`);
  }
  const steps = [...idOf.values()].filter((x) => x !== 'TRIGGER').sort();
  const edges = legacyEdges(spec.flow)
    .map((e) => `${idOf.get(e.from.toUpperCase())}>${idOf.get(e.to.toUpperCase())}>${e.status ?? 'default'}>${e.subStatus ?? '00'}`)
    .sort();
  return JSON.stringify([steps, edges]);
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkChain(spec: Rec, action: WriteAction): string[] {
  const errors: string[] = [];
  const allowed = ['description', 'info_area', 'start', 'steps', 'flow'];
  const unknown = Object.keys(spec).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unknown ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  if (action === 'create') {
    for (const f of ['description', 'info_area', 'steps', 'flow']) if (spec[f] === undefined) errors.push(`${f} is required`);
  }
  if (spec['description'] !== undefined && (typeof spec['description'] !== 'string' || !spec['description'] || spec['description'].length > 60)) errors.push('description must be a text of 1 to 60 characters');
  const start = spec['start'];
  if (start !== undefined && start !== 'immediate' && !(start && typeof start === 'object' && typeof (start as Rec)['event'] === 'string')) errors.push('start must be "immediate" or {event, parameter, once}');
  if ((spec['steps'] === undefined) !== (spec['flow'] === undefined)) errors.push('steps and flow go together (the complete chain)');
  if (spec['steps'] === undefined) return errors;
  if (!Array.isArray(spec['steps']) || !spec['steps'].length) return [...errors, 'steps must list at least one step'];
  if (!Array.isArray(spec['flow'])) return [...errors, 'flow must be a list of {from, to, on, branch}'];
  const ids = new Set<string>(['TRIGGER']);
  (spec['steps'] as Rec[]).forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!s || typeof s !== 'object') return void errors.push(`${at} must be an object`);
    if (typeof s['id'] !== 'string' || !s['id']) errors.push(`${at}.id is required`);
    else if (ids.has(s['id'].toUpperCase())) errors.push(`${at}: id ${s['id']} is used twice`);
    else ids.add(s['id'].toUpperCase());
    const extra = Object.keys(s).filter((k) => !STEP_FIELDS.has(k));
    if (extra.length) errors.push(`${at}: unknown ${extra.join(', ')}`);
    try {
      const k = kindOf(s as unknown as SpecStep);
      if (k === 'activate' && (!Array.isArray(s['activate']) || !s['activate'].length)) errors.push(`${at}.activate must list DataStore objects`);
      if (k === 'cleanup' && (!Array.isArray(s['cleanup']) || (s['cleanup'] as Rec[]).some((c) => typeof c?.['datastore'] !== 'string' || typeof c?.['action'] !== 'string'))) errors.push(`${at}.cleanup must list {datastore, action}`);
      if (k === 'collector' && !['AND', 'OR', 'XOR'].includes(String(s['collector']).toUpperCase())) errors.push(`${at}.collector must be AND, OR or XOR`);
      if (k === 'type' && typeof s['variant'] !== 'string') errors.push(`${at}: a step of type ${s['type']} names its variant`);
      if (s['formula'] !== undefined && k !== 'decision') errors.push(`${at}: formula belongs to a decision step`);
    } catch (err) {
      errors.push((err as Error).message);
    }
  });
  (spec['flow'] as Rec[]).forEach((e, i) => {
    const at = `flow[${i}]`;
    for (const end of ['from', 'to']) if (typeof e?.[end] !== 'string' || !ids.has(String(e[end]).toUpperCase())) errors.push(`${at}.${end} ${e?.[end] === undefined ? 'is required' : `"${e[end]}" is not a step id or TRIGGER`}`);
    if (e?.['on'] !== undefined && !['success', 'error', 'always'].includes(String(e['on']))) errors.push(`${at}.on must be success, error or always`);
    if (e?.['branch'] !== undefined && e?.['on'] !== undefined) errors.push(`${at}: a decision branch has no on`);
    if (String(e?.['to'] ?? '').toUpperCase() === 'TRIGGER') errors.push(`${at}: nothing leads into TRIGGER`);
  });
  if (!(spec['flow'] as Rec[]).some((e) => String(e?.['from'] ?? '').toUpperCase() === 'TRIGGER')) errors.push('flow needs at least one edge from TRIGGER');
  return errors;
}

/** Spec ids as the legacy builder expects them: upper case, TRIGGER for the start. */
function normalizeSpec(s: Rec): { steps: SpecStep[]; flow: SpecEdge[] } {
  const steps = (s['steps'] as SpecStep[]).map((x) => ({ ...x, id: x.id.toUpperCase() }));
  const flow = (s['flow'] as SpecEdge[]).map((e) => ({ ...e, from: e.from.toUpperCase(), to: e.to.toUpperCase() }));
  return { steps, flow };
}

// ── BW access ─────────────────────────────────────────────────────────────────

async function readModel(client: BwClient, name: string): Promise<Any> {
  const r = await client.rawGet(`/sap/bw/modeling/rspc/${bwSeg(name)}/m`, { Accept: READ_ACCEPT });
  return JSON.parse(r.body);
}

async function writeModel(client: BwClient, name: string, build: (current: Any) => Any, transport?: string): Promise<void> {
  const nameLc = name.toLowerCase();
  const got = await client.rawGet(`${BASE}/${nameLc}`, { Accept: 'application/json' });
  const etag = got.headers['etag'];
  if (!etag) throw new ToolError('backend', `No ETag for process chain ${name.toUpperCase()}; the chain cannot be changed safely.`);
  const root = JSON.parse(got.body);
  const model = build(root.model ?? root);
  const csrf = await client.getCsrfToken();
  const { header } = await resolveTransportHeader(client, `${BASE}/${nameLc}`, csrf, transport);
  const putCsrf = await client.getCsrfToken();
  try {
    await client.rawPut(`${BASE}/${nameLc}`, JSON.stringify(model), {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'x-csrf-token': putCsrf,
      'If-Match': etag,
      'X-Requested-With': 'XMLHttpRequest',
      ...header,
    });
  } catch (err) {
    if (/HTTP 412\b/.test((err as Error).message)) throw new ToolError('locked', `Process chain ${name.toUpperCase()} was changed by someone else meanwhile.`, 'Read it again and repeat the change.');
    throw err;
  } finally {
    refreshCsrf(client);
  }
}

/**
 * The new model: trigger rebuilt (the server's own trigger detail makes a changed topology fail
 * with HTTP 500), steps the chain already has taken over as they are, new steps built.
 */
export function buildModel(current: Any, wanted: { steps: SpecStep[]; flow: SpecEdge[] }, start: ChainSpec['start'] | undefined, header: { description?: string; info_area?: string }): Any {
  const nodes: Any[] = current.aNode ?? [];
  const triggerIdx = nodes.findIndex((n) => n.sProcessType === 'TRIGGER');
  if (triggerIdx < 0) throw new ToolError('backend', 'The process chain has no start step (TRIGGER).');
  const triggerKey = nodes[triggerIdx].sProcessVariant;
  const triggerDetail = inlineDetail(current, triggerKey);
  const event = start !== undefined ? triggerEventOf(start) : eventConfigFromDetail(triggerDetail);

  // Existing nodes by what they do, in chain order, for reuse.
  const pool = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    if (i === triggerIdx) return;
    const ident = identity({ id: '', ...nodeStep(current, n) } as SpecStep);
    pool.set(ident, [...(pool.get(ident) ?? []), i]);
  });

  const steps = legacySteps(wanted.steps);
  const { stepNodes, aEdge, stepInlineVariants } = buildModelParts(steps, legacyEdges(wanted.flow));
  const inlineOrder = steps.map((s, i) => (INLINE_STEP_TYPES.has(s.type) ? i : -1)).filter((i) => i >= 0);
  const outNodes: Any[] = [...stepNodes];
  const outInline: Any[] = [...stepInlineVariants];
  wanted.steps.forEach((s, i) => {
    // Collectors carry no settings, and their variant lives in an entry of its own; built anew.
    if (s.collector !== undefined) return;
    const hit = pool.get(identity(s))?.shift();
    if (hit === undefined) return;
    const old = nodes[hit];
    outNodes[i] = old;
    const k = inlineOrder.indexOf(i);
    if (k >= 0) {
      const oldVariant = (current.aInlineVariant ?? []).find((v: Any) => v.sProcessVariant === old.sProcessVariant);
      if (oldVariant) outInline[k] = oldVariant;
    }
  });
  const h = current.oHeader ?? {};
  return {
    aNode: [{ sProcessType: 'TRIGGER', bIsReference: false, sProcessVariant: triggerKey }, ...outNodes],
    aEdge,
    aInlineVariant: [{ sProcessVariant: triggerKey, sVariantDescription: '', oDetail: buildTriggerDetail(event, String(h.sProcessChainId ?? '')), aSocket: [] }, ...outInline],
    oHeader: { ...h, sDescription: header.description ?? h.sDescription, sLocation: header.info_area?.toUpperCase() ?? h.sLocation },
  };
}

/** Decision steps with a formula: create the decision variant when it does not exist yet. */
async function ensureDecisions(client: BwClient, steps: SpecStep[], pkg: string, transport?: string): Promise<string[]> {
  const notes: string[] = [];
  for (const s of steps) {
    if (s.decision === undefined || s.formula === undefined) continue;
    const name = s.decision.toUpperCase();
    const exists = await client.rawGet(`${DECISION_VARIANTS_BASE}/${name.toLowerCase()}`, { Accept: 'application/json' }).then(() => true, (err) => {
      if (isNotFound(err)) return false;
      throw err;
    });
    if (exists) {
      notes.push(`decision ${name} exists, formula left as it is`);
      continue;
    }
    const r = JSON.parse(await bwCreateDecisionVariant(client, { name, description: s.description ?? name, formula: s.formula, package: pkg, ...(transport ? { transportRequest: transport } : {}), ...(s.then ? { thenLabel: s.then } : {}), ...(s.else ? { elseLabel: s.else } : {}) })) as Rec;
    const act = r['activation'] as Rec | undefined;
    if (act && act['success'] === false) throw new ToolError('activation_failed', `Decision variant ${name}: ${String(act['message'] ?? 'not activated')}`);
    notes.push(`decision ${name} created`);
  }
  return notes;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** The condition of the first branch of a decision variant (the second is its complement). */
async function decisionFormula(client: BwClient, variant: string): Promise<string | undefined> {
  const r = await client.rawGet(`${DECISION_VARIANTS_BASE}/${variant.toLowerCase()}`, { Accept: 'application/json' });
  const root = JSON.parse(r.body);
  const detail: Any[] = (root.model ?? root).oDetail ?? [];
  const f = detail.find((d) => d.field === 'FORMULA')?.values?.find((v: Any) => Number(v.high) === 1)?.low;
  return f ? String(f).replace(/\s+/g, ' ').trim() : undefined;
}

function stepLine(s: SpecStep): string {
  switch (kindOf(s)) {
    case 'dtp':
      return `dtp ${s.dtp}`;
    case 'activate':
      return `activate ${(s.activate ?? []).join(', ')}${s.sequential ? ' (sequential)' : ''}${s.fail_if_nothing_activated ? ' (fail if nothing activated)' : ''}`;
    case 'cleanup':
      return `cleanup ${(s.cleanup ?? []).map((c) => `${c.datastore} action ${c.action}${c.all_requests ? ' all' : ''}${c.keep_requests ? ` keep ${c.keep_requests}` : ''}${c.older_than_days ? ` older than ${c.older_than_days} d` : ''}`).join('; ')}`;
    case 'program':
      return `program ${s.program}${s.variant ? ` variant ${s.variant}` : ''}${s.synchronous === false ? ' (asynchronous)' : ''}${s.local === false ? ' (remote)' : ''}`;
    case 'collector':
      return `collector ${s.collector}`;
    case 'decision':
      return `decision ${s.decision}`;
    default:
      return `type ${s.type} variant ${s.variant}`;
  }
}

export function summarizeChain(name: string, model: Any, full: boolean, formulas: Map<string, string> = new Map()): string {
  const { spec, settings, texts, branches } = modelToSpec(model);
  const h = model.oHeader ?? {};
  const status = h.sObjectStatus === 'active' ? 'active' : String(h.sObjectStatus || 'inactive');
  const start = spec.start === 'immediate' ? 'start immediately' : `start on event ${spec.start.event}${spec.start.parameter ? ` (${spec.start.parameter})` : ''}${spec.start.once ? ', once' : ''}`;
  const lines = [`RSPC ${name.toUpperCase()} "${spec.description}" · ${status} · InfoArea ${spec.info_area || '?'} · ${start}`];
  const w = Math.max(4, ...spec.steps.map((s) => s.id.length));
  lines.push(`Steps (${spec.steps.length}):`);
  for (const s of spec.steps) {
    const decision = s.decision !== undefined ? [formulas.get(s.decision.toUpperCase()) ? `formula ${formulas.get(s.decision.toUpperCase())}` : '', branches.get(s.id)?.length ? `branches ${branches.get(s.id)!.join(', ')}` : ''] : [];
    const extra = [texts.get(s.id) ? `"${texts.get(s.id)}"` : '', ...decision, ...(settings.get(s.id) ?? []).map((x) => `[${x}]`)].filter(Boolean).join(' · ');
    lines.push(`  ${s.id.padEnd(w)}  ${stepLine(s)}${extra ? `  ${extra}` : ''}`);
  }
  // One line per source and condition: "A → B, C (always)".
  const byFrom = new Map<string, string[]>();
  for (const e of spec.flow) {
    const cond = e.branch ? `branch ${e.branch}` : e.on ?? '';
    const key = `${e.from}|${cond}`;
    byFrom.set(key, [...(byFrom.get(key) ?? []), e.to]);
  }
  lines.push('Flow (on: success unless named):');
  const order = ['TRIGGER', ...spec.steps.map((x) => x.id)];
  const sorted = [...byFrom].sort(([a], [b]) => order.indexOf(a.split('|')[0]) - order.indexOf(b.split('|')[0]));
  for (const [key, tos] of sorted) {
    const [from, cond] = key.split('|');
    lines.push(`  ${from} → ${tos.join(', ')}${cond ? ` (${cond})` : ''}`);
  }
  if (full) {
    const sched = h.oSchedulingAttributes ?? {};
    const mon = h.oMonitoringAttributes ?? {};
    const flags = Object.entries(mon).filter(([, v]) => v === true).map(([k]) => k.replace(/^b/, ''));
    lines.push(`Scheduling: priority ${sched.sJobPriority ?? '?'}${sched.oJobOwner?.sJobOwner ? ` · job owner ${sched.oJobOwner.sJobOwner}` : ''}${sched.sExecutionServer ? ` · server ${sched.sExecutionServer}` : ''}${sched.bStreaming ? ' · streaming' : ''}`);
    lines.push(`Monitoring: ${flags.join(', ') || 'defaults'}`);
  }
  return lines.join('\n');
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const DESCRIBE_CREATE = [
  'RSPC create spec (process chain: steps that run loads and other processes; package $TMP)',
  'Not a CompositeProvider (a union or join of providers is HCPR).',
  '  description   text, max 60                                            (required)',
  '  info_area     InfoArea                                                (required)',
  '  start         "immediate" (default) | {event, parameter, once}',
  '  steps         [{id, <one kind>}]                                      (required)',
  '                dtp: DTP name · activate: [ADSO, …] (sequential, fail_if_nothing_activated)',
  '                cleanup: [{datastore, action, all_requests, keep_requests, older_than_days}]',
  '                program: ABAP report (variant, synchronous, local) · collector: AND | OR | XOR',
  '                decision: variant (formula, then, else: created when it does not exist)',
  '                type + variant: any other process type with its variant (e.g. CHAIN)',
  '  flow          [{from, to, on, branch}]: from TRIGGER or a step id; on success (default),',
  '                error or always; branch "01"/"02" out of a decision     (required)',
  'Activated in the same call (activate=false leaves it inactive).',
  'Example',
  '  {"action":"create","type":"RSPC","name":"ZPC_LOAD","spec":{"description":"Load sales","info_area":"ZSALES","steps":[{"id":"LOAD","dtp":"DTP_0ABC…"},{"id":"ACT","activate":["ZSALES01"]}],"flow":[{"from":"TRIGGER","to":"LOAD"},{"from":"LOAD","to":"ACT"}]}}',
].join('\n');

const DESCRIBE_UPDATE = [
  'RSPC update spec — only the named parts change',
  '  description, info_area, start   as in create',
  '  steps + flow  the complete new chain, as bw_read shows it (ids are free to choose).',
  '                Steps the chain has already are kept as they are, with their settings',
  '                (repeat, wait times, notifications); the same chain again is unchanged.',
  'Activated in the same call.',
].join('\n');

/**
 * The settings of one process variant: its detail as path = value lines (empty values left
 * out), and the outcomes it can report.
 */
export function summarizeVariant(type: string, name: string, pv: Any): string {
  const lines = [`Variant ${name} (${type}) "${pv.sVariantDescription ?? ''}"${pv.bActive === false ? ' · inactive' : ''}`];
  const flat: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i + 1}]`));
    // Links and change stamps of referenced objects add nothing to the settings.
    if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).filter(([k]) => !/^(uri|changedOn|changedBy|version|status)$/.test(k)).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
    flat.push(`  ${path} = ${String(v).trim()}`);
  };
  walk(pv.oDetail, '');
  lines.push(...(flat.length ? ['Settings:', ...flat.slice(0, 200)] : ['Settings: none']));
  if (flat.length > 200) lines.push(`  … ${flat.length - 200} more (detail="raw" shows all)`);
  const outcomes = (pv.aSocket ?? []).map((x: Any) => x.sDescription || x.sStatus).filter(Boolean);
  if (outcomes.length) lines.push(`Outcomes: ${outcomes.join(', ')}`);
  return lines.join('\n');
}

export const rspcAdapter: ObjectAdapter = {
  type: 'RSPC' as BwType,
  label: 'Process chain',
  async locate(client, name) {
    try {
      const m = await readModel(client, name);
      const h = m.oHeader ?? {};
      const area = stripInfoAreaSentinel(String(h.sLocation ?? ''));
      return { exists: true, ...(area ? { infoArea: area } : {}), active: h.sObjectStatus === 'active' };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },
  async read(client, name, { detail, part }: ReadOptions) {
    let model: Any;
    try {
      model = await readModel(client, name);
    } catch (err) {
      if (isNotFound(err)) throw new ToolError('not_found', `RSPC ${name.toUpperCase()} not found.`, `Check the name with bw_search(query="${name.toUpperCase().slice(0, 4)}*", types=["RSPC"]).`);
      throw err;
    }
    const wanted = /^variant:(.+)$/i.exec(part ?? '')?.[1]?.trim().toUpperCase();
    if (wanted) {
      const node = (model.aNode ?? []).find((n: Any) => String(n.sProcessVariant ?? '').toUpperCase() === wanted);
      if (!node) {
        const all = (model.aNode ?? []).map((n: Any) => `${n.sProcessVariant} (${n.sProcessType})`).join(', ');
        throw new ToolError('not_found', `No step of RSPC ${name.toUpperCase()} uses variant ${wanted}.`, `Variants: ${all || 'none'}.`);
      }
      const { body } = await client.rawGet(`/sap/bw4/v1/modeling/processtypes/${encodeURIComponent(String(node.sProcessType).toLowerCase())}/variants/${encodeURIComponent(wanted)}/m`, { Accept: 'application/json' });
      if (detail === 'raw') return body;
      return summarizeVariant(String(node.sProcessType), wanted, JSON.parse(body) as Any);
    }
    if (part) throw new ToolError('validation', `RSPC has no part ${part}.`, 'part="variant:<VARIANT>" reads the settings of one step\'s process variant.');
    if (detail === 'raw') return JSON.stringify(model, null, 2);
    const formulas = new Map<string, string>();
    for (const n of model.aNode ?? []) {
      if (n.sProcessType !== 'DECISION' || !n.sProcessVariant) continue;
      const f = await decisionFormula(client, String(n.sProcessVariant)).catch(() => undefined);
      if (f) formulas.set(String(n.sProcessVariant).toUpperCase(), f);
    }
    return `${summarizeChain(name, model, detail === 'full', formulas)}\nSettings of one step: part="variant:<VARIANT>".`;
  },
  describe: (action) => (action === 'create' ? DESCRIBE_CREATE : DESCRIBE_UPDATE),
  check(action, _name, spec) {
    if (action === 'delete') return [];
    return checkChain((spec ?? {}) as Rec, action);
  },
  dependsOn(action, _name, spec) {
    if (action === 'delete') return [];
    const refs: ObjectRef[] = [];
    for (const s of (((spec ?? {}) as Rec)['steps'] as SpecStep[] | undefined) ?? []) {
      if (typeof s?.dtp === 'string') refs.push({ type: 'DTPA', name: s.dtp.toUpperCase() });
      for (const a of Array.isArray(s?.activate) ? s.activate : []) refs.push({ type: 'ADSO', name: String(a).toUpperCase() });
      if (typeof s?.type === 'string' && s.type.toUpperCase() === 'CHAIN' && typeof s.variant === 'string') refs.push({ type: 'RSPC', name: s.variant.toUpperCase() });
    }
    return refs;
  },
  targetInfoArea: (_name, spec) => (typeof (spec as Rec)['info_area'] === 'string' ? String((spec as Rec)['info_area']).toUpperCase() : undefined),
  async activate(client, name) {
    let r: Awaited<ReturnType<typeof activateChain>>;
    try {
      r = await activateChain(client, name.toLowerCase());
    } catch (err) {
      // A refused activation comes as HTTP 400 with the activation log as its body.
      const body = (err as Error).message.match(/HTTP 4\d\d\n([\s\S]*)$/)?.[1];
      if (!body) throw err;
      r = parseActivateResponse(body);
    }
    const messages = [...new Set([...r.errors, ...r.log].map((l) => l.message).filter((m) => m && m !== 'Activation failed'))];
    return { ok: r.success, messages: messages.length ? messages : [r.message || 'activation failed'], deactivated: [] };
  },
  async create(name, spec, ctx) {
    if (ctx.package.toUpperCase() !== '$TMP') throw new ToolError('not_implemented', 'Process chains are created in $TMP only for now.', 'Create it in $TMP; moving it to a package follows with bw_transport.');
    const s = spec as Rec;
    const { steps, flow } = normalizeSpec(s);
    const notes = await ensureDecisions(ctx.client, steps, ctx.package, ctx.transport);
    await bwCreateProcessChain(ctx.client, {
      name: name.toUpperCase(),
      infoarea: String(s['info_area']).toUpperCase(),
      description: String(s['description']),
      steps: legacySteps(steps),
      edges: legacyEdges(flow),
      activate: false,
      ...(triggerEventOf(s['start'] as ChainSpec['start']) ? { triggerEvent: triggerEventOf(s['start'] as ChainSpec['start']) } : {}),
    });
    return { status: 'created', activation: { lockHandle: '' }, notes: [`${steps.length} step${steps.length === 1 ? '' : 's'}`, ...notes] };
  },
  async update(name, spec, ctx) {
    const s = spec as Rec;
    const current = await readModel(ctx.client, name);
    const { spec: now } = modelToSpec(current);
    const notes: string[] = [];
    const wanted = s['steps'] !== undefined ? normalizeSpec(s) : undefined;
    const description = typeof s['description'] === 'string' && s['description'] !== now.description ? s['description'] : undefined;
    const infoArea = typeof s['info_area'] === 'string' && s['info_area'].toUpperCase() !== now.info_area.toUpperCase() ? s['info_area'].toUpperCase() : undefined;
    const startChanged = s['start'] !== undefined && JSON.stringify(triggerEventOf(s['start'] as ChainSpec['start']) ?? null) !== JSON.stringify(triggerEventOf(now.start) ?? null);
    const treeChanged = wanted !== undefined && canonical(wanted) !== canonical(now);
    if (!description && !infoArea && !startChanged && !treeChanged) return { status: 'unchanged' };
    if (wanted) notes.push(...(await ensureDecisions(ctx.client, wanted.steps, ctx.package, ctx.transport)));
    const target = wanted ?? { steps: now.steps.map((x) => ({ ...x, id: x.id.toUpperCase() })), flow: now.flow };
    await writeModel(ctx.client, name, (model) => buildModel(model, target, s['start'] as ChainSpec['start'] | undefined, { ...(description ? { description } : {}), ...(infoArea ? { info_area: infoArea } : {}) }), ctx.transport);
    if (description) notes.push('description');
    if (infoArea) notes.push(`InfoArea ${infoArea}`);
    if (startChanged) notes.push('start');
    if (treeChanged && wanted) notes.push(`steps ${now.steps.length} → ${wanted.steps.length}`);
    return { status: 'changed', activation: { lockHandle: '' }, notes };
  },
  async delete(name, ctx) {
    // Decision variants are objects of their own; the ones this chain uses go with it unless
    // BW refuses because another chain still uses them.
    const model = await readModel(ctx.client, name).catch(() => undefined);
    const decisions = [...new Set(((model?.aNode ?? []) as Any[]).filter((n) => n.sProcessType === 'DECISION').map((n) => String(n.sProcessVariant)))];
    await bwDelete(ctx.client, 'rspc', name);
    const notes: string[] = [];
    for (const d of decisions) {
      try {
        const csrf = await ctx.client.getCsrfToken();
        await ctx.client.rawDelete(`${DECISION_VARIANTS_BASE}/${d.toLowerCase()}`, { 'Content-Type': 'application/json', Accept: '*/*', 'x-csrf-token': csrf, 'X-Requested-With': 'XMLHttpRequest' });
        notes.push(`decision ${d} deleted`);
      } catch (err) {
        notes.push(`decision ${d} kept: ${(err as Error).message.split('\n').slice(-1)[0].slice(0, 160)}`);
      } finally {
        refreshCsrf(ctx.client);
      }
    }
    return { status: 'deleted', notes };
  },
};
