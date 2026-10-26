// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: the proven runtime, reporting and transport paths.
// Changes for coBWeb are marked "coBWeb:". The tools in src/tools/runtime.ts call into this module.

import { BwClient } from '../bw/client.js';
import { queryTable, sqlLiteral, type Row } from './metadata_sql.js';

/**
 * BW query statistics (RSDDSTAT*), read through ADT DataPreview.
 *
 * Every navigation step of a query is recorded with its runtime per OLAP event, whichever
 * frontend issued it, and under principal propagation the steps of this server carry the
 * calling user. There is no REST resource for them, so the tables are read directly. Every
 * statement is built here from fixed text plus escaped object names and step ids, and stays
 * within the 255 characters the DataPreview parser reads.
 */

export const MAX_STATEMENT = 255;

/** STARTTIME is a UTC timestamp of the form YYYYMMDDhhmmss.fffffff. */
export function statStamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function stampToIso(stamp: string): string {
  const s = stamp.replace(/\D/g, '').padEnd(14, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)} UTC`;
}

/** The object name a step is recorded under: the query, or "$" plus the provider for a direct call. */
export function statObjectName(compId: string, isProvider: boolean): string {
  return (isProvider ? `$${compId}` : compId).toUpperCase();
}

/** Other front ends record a direct provider call under "$!1" plus the provider. */
export function statObjectNames(compId: string, isProvider: boolean): string[] {
  const name = compId.toUpperCase();
  return isProvider ? [`$${name}`, `$!1${name}`] : [name];
}

function checked(sql: string): string {
  if (sql.length > MAX_STATEMENT) {
    throw new Error(`The statistics statement is ${sql.length} characters long; DataPreview reads at most ${MAX_STATEMENT}.`);
  }
  return sql;
}

// A step carries one header row per handle (MDX and OLAP, for instance), so the steps of an
// object are selected through a subquery rather than a join: every step comes back once.
function inWindow(objName: string, from: Date, to: Date): string {
  return (
    `FROM rsddstatinfo WHERE stepuid IN ( SELECT stepuid FROM rsddstatheader WHERE objname = '${sqlLiteral(objName)}' ) ` +
    `AND starttime BETWEEN ${statStamp(from)} AND ${statStamp(to)}`
  );
}

export type StepOrder = 'latest' | 'slowest';

export function stepsStatement(objName: string, from: Date, to: Date, order: StepOrder = 'latest'): string {
  return checked(
    `SELECT stepuid, uname, starttime, runtime ${inWindow(objName, from, to)} ` +
      `ORDER BY ${order === 'latest' ? 'starttime' : 'runtime'} DESCENDING`
  );
}

/** Executions per user; their sum is the number of executions in the window. */
export function usersStatement(objName: string, from: Date, to: Date): string {
  return checked(`SELECT uname, COUNT(*) AS n ${inWindow(objName, from, to)} GROUP BY uname`);
}

/** Classic releases have no EVPROP column, and with it no record of the HANA execution mode. */
export function eventsStatement(stepUid: string, withProp = true): string {
  return checked(
    `SELECT e~handletp, e~eventid, e~evtime, e~evcount${withProp ? ', e~evprop' : ''}, t~txtlg FROM rsddstatevdata AS e ` +
      `LEFT OUTER JOIN rsddstateventst AS t ON t~eventid = e~eventid AND t~langu = 'E' ` +
      `WHERE e~stepuid = '${sqlLiteral(stepUid)}'`
  );
}

export function dataManagerStatement(stepUid: string): string {
  return checked(
    `SELECT infoprov, partprov, timedmprep, timeread, timesid, timenavattr, timehierarchy, dbsel, dbtrans ` +
      `FROM rsddstatdm WHERE stepuid = '${sqlLiteral(stepUid)}'`
  );
}

export function headerStatement(stepUid: string): string {
  return checked(`SELECT handletp, infoprov, objname FROM rsddstatheader WHERE stepuid = '${sqlLiteral(stepUid)}'`);
}

export function infoStatement(stepUid: string): string {
  return checked(`SELECT stepuid, uname, starttime, runtime FROM rsddstatinfo WHERE stepuid = '${sqlLiteral(stepUid)}'`);
}

export interface Step {
  stepUid: string;
  user: string;
  start: string;
  runtime: number;
}

function toStep(r: Row): Step {
  return { stepUid: r.STEPUID, user: r.UNAME, start: r.STARTTIME, runtime: Number(r.RUNTIME) || 0 };
}

/** How many of the latest executions are read for the runtime percentiles. */
export const MAX_STEPS = 5000;

export async function stepsInWindow(
  client: BwClient,
  objName: string,
  from: Date,
  to: Date,
  order: StepOrder = 'latest',
  maxRows = MAX_STEPS,
): Promise<Step[]> {
  return (await queryTable(client, stepsStatement(objName, from, to, order), maxRows)).map(toStep);
}

export interface UserCount {
  user: string;
  executions: number;
}

export async function usersInWindow(client: BwClient, objName: string, from: Date, to: Date): Promise<UserCount[]> {
  const rows = await queryTable(client, usersStatement(objName, from, to), MAX_STEPS);
  return rows.map((r) => ({ user: r.UNAME, executions: Number(r.N) || 0 }));
}

// ── Event breakdown ──────────────────────────────────────────────────────────

const LAYERS = [
  'OLAP processor',
  'OLAP cache',
  'Authorizations',
  'Data manager / database',
  'Input help',
  'Planning',
  'Transfer to front end',
  'BICS provider',
  'MDX / OLAP BAPI',
  'Remote function calls',
  'Front end / application',
  'Not assigned',
] as const;
type Layer = (typeof LAYERS)[number];

/** Events that carry a count, a size or a gross runtime in EVCOUNT rather than a time. */
const COUNT_EVENTS = new Set([
  2525, 2530, 9010, 9011, 12502, 12503, 12504, 12505, 15010, 15011, 15012, 15103, 15104,
  50009, 50011, 50012, 50013, 50014, 50015, 50016, 50017, 50018, 50019, 50080, 50081, 50090, 50091,
]);

export function layerOf(eventId: number): Layer {
  // 1 is the user's wait time, outside the BW runtime like the non-assigned time.
  if (eventId === 0 || eventId === 1 || eventId === 1000) return 'Not assigned';
  if (eventId >= 2500 && eventId < 2600) return 'OLAP cache';
  if (eventId >= 4000 && eventId < 5000) return 'Authorizations';
  if (eventId >= 6000 && eventId < 6100) return 'Input help';
  if (eventId >= 9000 && eventId < 10000) return 'Data manager / database';
  if (eventId === 3200) return 'Transfer to front end';
  if (eventId === 10000) return 'Remote function calls';
  if (eventId >= 13000 && eventId < 14000) return 'BICS provider';
  if ((eventId >= 12500 && eventId < 13000) || (eventId >= 14000 && eventId < 30000)) return 'Front end / application';
  if (eventId >= 40000 && eventId < 41000) return 'MDX / OLAP BAPI';
  if (eventId >= 50000 && eventId < 52000) return 'Planning';
  return 'OLAP processor';
}

export interface EventRow {
  handleType: string;
  eventId: number;
  time: number;
  count: number;
  prop: string;
  text: string;
}

export function toEvents(rows: Row[]): EventRow[] {
  return rows.map((r) => ({
    handleType: r.HANDLETP ?? '',
    eventId: Number(r.EVENTID) || 0,
    time: Number(r.EVTIME) || 0,
    count: Number(r.EVCOUNT) || 0,
    prop: (r.EVPROP ?? '').trim(),
    text: r.TXTLG ?? '',
  }));
}

export interface Breakdown {
  layers: Array<{ layer: Layer; seconds: number }>;
  top: EventRow[];
  recordsRead?: number;
  recordsTransferred?: number;
  hanaMode?: string;
}

export function breakdown(events: EventRow[], topN = 8): Breakdown {
  const sums = new Map<Layer, number>();
  let recordsRead: number | undefined;
  let recordsTransferred: number | undefined;
  let hanaMode: string | undefined;
  for (const e of events) {
    if (e.eventId === 9011) recordsRead = (recordsRead ?? 0) + e.count;
    if (e.eventId === 9010) recordsTransferred = (recordsTransferred ?? 0) + e.count;
    if (e.eventId === 3115 && e.prop) hanaMode = e.prop;
    if (COUNT_EVENTS.has(e.eventId)) continue;
    sums.set(layerOf(e.eventId), (sums.get(layerOf(e.eventId)) ?? 0) + e.time);
  }
  const layers = LAYERS.filter((l) => sums.has(l)).map((layer) => ({ layer, seconds: sums.get(layer)! }));
  const top = events
    .filter((e) => !COUNT_EVENTS.has(e.eventId) && e.time > 0)
    .sort((a, b) => b.time - a.time)
    .slice(0, topN);
  return { layers, top, recordsRead, recordsTransferred, hanaMode };
}

const fmtS = (s: number) => `${s.toFixed(3)} s`;
const fmtN = (n: number) => n.toLocaleString('en-US');

async function hanaModeTexts(client: BwClient): Promise<Map<string, string>> {
  try {
    const rows = await queryTable(
      client,
      checked(`SELECT domvalue_l, ddtext FROM dd07t WHERE domname = 'RSRTREXOPS' AND ddlanguage = 'E'`)
    );
    return new Map(rows.map((r) => [r.DOMVALUE_L.trim(), r.DDTEXT]));
  } catch {
    return new Map();
  }
}

export interface StepDetail {
  step: Step;
  objName: string;
  provider: string;
  breakdown: Breakdown;
  dataManager: Row[];
}

export async function readStep(client: BwClient, stepUid: string, step?: Step): Promise<StepDetail> {
  const info = step ?? (await queryTable(client, infoStatement(stepUid))).map(toStep)[0];
  if (!info) throw new Error(`No statistics step ${stepUid}.`);
  const header = await queryTable(client, headerStatement(stepUid));
  const olap = header.find((h) => h.HANDLETP === 'OLAP') ?? header.find((h) => h.OBJNAME) ?? header[0];
  const events = toEvents(
    await queryTable(client, eventsStatement(stepUid)).catch((err: Error) => {
      if (!/EVPROP/i.test(err.message)) throw err;
      return queryTable(client, eventsStatement(stepUid, false));
    })
  );
  // Empty below statistics level 2; the event times still carry the data manager total.
  const dataManager = await queryTable(client, dataManagerStatement(stepUid)).catch(() => [] as Row[]);
  return {
    step: info,
    objName: olap?.OBJNAME ?? '',
    provider: olap?.INFOPROV ?? '',
    breakdown: breakdown(events),
    dataManager,
  };
}

export function formatStep(d: StepDetail, modes: Map<string, string>, indent = '  '): string[] {
  const lines: string[] = [];
  const { step, breakdown: b } = d;
  lines.push(
    `${indent}Step ${step.stepUid}: ${d.objName || '?'}${d.provider ? ` on ${d.provider}` : ''}, user ${step.user}, ` +
      `${stampToIso(step.start)}, BW runtime ${fmtS(step.runtime)}`
  );
  // Shares of the step's BW runtime. The non-assigned event can hold time outside the step,
  // the front end's wait among it on classic releases, so it gets no share.
  const total = step.runtime || b.layers.reduce((s, l) => s + l.seconds, 0) || 1;
  for (const l of b.layers) {
    const share = l.layer === 'Not assigned' ? '' : `  ${Math.round((l.seconds / total) * 100)}%`;
    lines.push(`${indent}  ${l.layer.padEnd(24)} ${fmtS(l.seconds).padStart(10)}${share}`);
  }
  if (b.recordsRead || b.recordsTransferred) {
    lines.push(`${indent}  Records read ${fmtN(b.recordsRead ?? 0)}, transferred ${fmtN(b.recordsTransferred ?? 0)}`);
  }
  if (b.hanaMode) {
    const text = modes.get(b.hanaMode);
    lines.push(`${indent}  Operations in SAP HANA: ${b.hanaMode}${text ? ` (${text})` : ''}`);
  }
  if (b.top.length > 0) {
    lines.push(`${indent}  Top events:`);
    for (const e of b.top) lines.push(`${indent}    ${fmtS(e.time).padStart(10)}  ${e.eventId} ${e.text}`.trimEnd());
  }
  if (d.dataManager.length > 0) {
    lines.push(`${indent}  Data manager per provider:`);
    for (const r of d.dataManager) {
      const t = ['TIMEDMPREP', 'TIMEREAD', 'TIMESID', 'TIMENAVATTR', 'TIMEHIERARCHY'].reduce((s, k) => s + (Number(r[k]) || 0), 0);
      const part = r.PARTPROV && r.PARTPROV !== r.INFOPROV ? ` / ${r.PARTPROV}` : '';
      lines.push(`${indent}    ${r.INFOPROV}${part}: ${fmtS(t)}, read ${fmtN(Number(r.DBSEL) || 0)}, transferred ${fmtN(Number(r.DBTRANS) || 0)}`);
    }
  }
  return lines;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * `latest` are the most recent executions, newest first, at most MAX_STEPS of them; `users`
 * counts every execution in the window, so the total stays right when `latest` is cut short.
 */
export function summarize(latest: Step[], users: UserCount[]): string[] {
  const total = Math.max(users.reduce((s, u) => s + u.executions, 0), latest.length);
  const times = latest.map((s) => s.runtime).sort((a, b) => a - b);
  const over = latest.length < total ? ` over the latest ${fmtN(latest.length)} of ${fmtN(total)}` : '';
  const byUser = [...users].sort((a, b) => b.executions - a.executions || a.user.localeCompare(b.user));
  return [
    `  Executions: ${fmtN(total)}`,
    `  Last: ${stampToIso(latest[0].start)} by ${latest[0].user}`,
    `  Runtime${over}: min ${fmtS(times[0])}, median ${fmtS(percentile(times, 50))}, ` +
      `p90 ${fmtS(percentile(times, 90))}, max ${fmtS(times[times.length - 1])}`,
    `  Users: ${byUser.slice(0, 20).map((u) => `${u.user} (${fmtN(u.executions)})`).join(', ')}` +
      (byUser.length > 20 ? `, and ${byUser.length - 20} more` : ''),
  ];
}

// ── Tool: bw_query_statistics ────────────────────────────────────────────────

export interface QueryStatisticsArgs {
  query_name?: string;
  provider?: string;
  step_uid?: string;
  from?: string;
  to?: string;
  hours?: number;
  slowest?: number;
}

function parseTime(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date or timestamp: "${value}".`);
  return d;
}

export async function bwQueryStatistics(client: BwClient, args: QueryStatisticsArgs): Promise<string> {
  const modes = await hanaModeTexts(client);
  if (args.step_uid) {
    const detail = await readStep(client, args.step_uid.trim().toUpperCase());
    return ['BW statistics, one step:', ...formatStep(detail, modes)].join('\n');
  }
  if (!!args.query_name === !!args.provider) throw new Error('Pass exactly one of query_name, provider or step_uid.');
  const objNames = statObjectNames((args.query_name ?? args.provider)!, !!args.provider);
  const to = args.to ? parseTime(args.to, 'to') : new Date();
  const from = args.from ? parseTime(args.from, 'from') : new Date(to.getTime() - (args.hours ?? 24) * 3600_000);
  if (from >= to) throw new Error('from must lie before to.');
  const window = `${stampToIso(statStamp(from))} to ${stampToIso(statStamp(to))}`;
  const slowestN = Math.max(0, Math.min(args.slowest ?? 3, 10));

  const sections: string[] = [];
  for (const objName of objNames) {
    const users = await usersInWindow(client, objName, from, to);
    if (users.length === 0) continue;
    const latest = await stepsInWindow(client, objName, from, to);
    const lines = [`BW statistics for ${objName}, ${window}:`, ...summarize(latest, users)];
    const slowest = slowestN > 0 ? await stepsInWindow(client, objName, from, to, 'slowest', slowestN) : [];
    if (slowest.length > 0) {
      lines.push('', `Slowest ${slowest.length}:`);
      for (const s of slowest) lines.push(...formatStep(await readStep(client, s.stepUid, s), modes), '');
    }
    sections.push(lines.join('\n').trimEnd());
  }
  if (sections.length > 0) return sections.join('\n\n');
  return [
    `BW statistics for ${objNames.join(' / ')}, ${window}:`,
    '  No executions recorded. Either it did not run in this window, or statistics are switched off ' +
      'for it (transaction RSDDSTAT).',
  ].join('\n');
}

// ── bw_query_data with_statistics ────────────────────────────────────────────

export interface CallTiming {
  started: Date;
  finished: Date;
  httpMs: number;
  requestBytes: number;
  responseBytes: number;
  renderMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The statistics of one bw_query_data call: its own timing, and the BW step recorded for it.
 * A step is written when it ends, so a step not yet visible is looked for once more.
 */
export async function statisticsForCall(
  client: BwClient,
  objName: string,
  timing: CallTiming,
  user?: string,
): Promise<string[]> {
  const lines = [
    '── Timing ──',
    `  Server total ${timing.finished.getTime() - timing.started.getTime()} ms, BW HTTP request ${timing.httpMs} ms` +
      `${timing.renderMs !== undefined ? `, rendering ${timing.renderMs} ms` : ''}`,
    `  Request ${fmtN(timing.requestBytes)} bytes, response ${fmtN(timing.responseBytes)} bytes`,
    `  Window ${stampToIso(statStamp(timing.started))} to ${stampToIso(statStamp(timing.finished))}`,
  ];
  const from = new Date(timing.started.getTime() - 2000);
  const to = new Date(timing.finished.getTime() + 2000);
  let steps: Step[] = [];
  try {
    for (let attempt = 0; attempt < 2 && steps.length === 0; attempt++) {
      if (attempt > 0) await sleep(1500);
      steps = await stepsInWindow(client, objName, from, to);
      if (user) steps = steps.filter((s) => s.user.toUpperCase() === user.toUpperCase());
    }
  } catch (err) {
    lines.push('', '── BW statistics ──', `  Not readable: ${(err as Error).message.split('\n')[0]}`);
    return lines;
  }
  lines.push('', '── BW statistics ──');
  if (steps.length === 0) {
    lines.push(`  No step recorded for ${objName} in this window; statistics may be switched off for it (transaction RSDDSTAT).`);
    return lines;
  }
  const modes = await hanaModeTexts(client);
  for (const s of steps) lines.push(...formatStep(await readStep(client, s.stepUid, s), modes));
  if (steps.length === 1) {
    const bwMs = Math.round(steps[0].runtime * 1000);
    lines.push(`  HTTP ${timing.httpMs} ms = BW ${bwMs} ms + transfer and network ${Math.max(0, timing.httpMs - bwMs)} ms`);
  }
  return lines;
}
