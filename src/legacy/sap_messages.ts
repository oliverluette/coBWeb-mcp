// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: the proven runtime, reporting and transport paths.
// Changes for coBWeb are marked "coBWeb:". The tools in src/tools/runtime.ts call into this module.

import { BwClient } from '../bw/client.js';
import { queryTable, sqlLiteral } from './metadata_sql.js';

/**
 * SAP message handling shared by the monitoring tools: the long text of a message, the
 * structured message variables, the program location a runtime error names, and the step
 * log of a process chain node.
 *
 * The cause of a failed load is often only in these places. A transformation that catches a
 * runtime error leaves no short dump; the error text, the rule and the program location are
 * the variables of a generic message ("runtime error while executing the rule -> long text"),
 * and the message line itself names none of them.
 */

// ── Long text ───────────────────────────────────────────────────────────────

export interface LongTextSection {
  heading: string;
  text: string;
}

export interface LongText {
  /** The message text as the document title restates it. */
  title: string;
  /** Message class and number, e.g. "AB123", taken from the line under the title. */
  number?: string;
  /** Diagnosis, system response, procedure — whatever the document has, in its language. */
  sections: LongTextSection[];
}

const ENTITY_RE = /&(lt|gt|quot|apos|amp|nbsp|#\d+|#x[0-9a-f]+);/gi;

function decodeEntities(value: string): string {
  return value.replace(ENTITY_RE, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'amp') return '&';
    if (k === 'nbsp') return ' ';
    if (k.startsWith('#x')) return String.fromCharCode(parseInt(k.slice(2), 16));
    return String.fromCharCode(Number(k.slice(1)));
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse the long text the monitoring APIs attach to a message.
 *
 * It is the SAPscript help document converted to HTML, delivered HTML-escaped — once by the
 * OData service, twice by the process chain node log. Its shape is fixed: the message as an
 * H3 title, a paragraph with the message number, then one H3 heading per section with its
 * paragraphs. The headings are in the logon language, so sections are taken by structure
 * rather than by name.
 */
export function parseLongText(raw: string | undefined): LongText | undefined {
  if (!raw) return undefined;
  let html = raw;
  for (let i = 0; i < 3 && !/<\s*\/?[a-z]/i.test(html) && /&(lt|amp);/i.test(html); i++) {
    html = decodeEntities(html);
  }
  html = html.replace(/<head\b[\s\S]*?<\/head>/i, '');

  const parts = html.split(/<h\d\b[^>]*>([\s\S]*?)<\/h\d>/i);
  // parts: [before, h1, after1, h2, after2, ...]
  const blocks: { heading: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    blocks.push({ heading: stripTags(parts[i]), body: parts[i + 1] ?? '' });
  }
  if (blocks.length === 0) {
    const text = stripTags(html);
    return text ? { title: text, sections: [] } : undefined;
  }

  const paragraphs = (body: string): string[] =>
    body
      .split(/<\/p>|<br\s*\/?>/i)
      .map(stripTags)
      .filter(Boolean);

  const [first, ...rest] = blocks;
  const numberLine = paragraphs(first.body)[0];
  const number = numberLine?.match(/([A-Z0-9_/]+)\s*$/)?.[1];

  return {
    title: first.heading,
    number,
    sections: rest
      .map((b) => ({ heading: b.heading, text: paragraphs(b.body).join(' ') }))
      .filter((s) => s.heading || s.text),
  };
}

/**
 * Render the sections of a long text as indented lines, or nothing when the document only
 * restates the message. Capped, because a few help documents run to pages.
 */
export function formatLongText(lt: LongText | undefined, indent: string, maxChars = 1500): string[] {
  if (!lt || lt.sections.length === 0) return [];
  const lines: string[] = [];
  let used = 0;
  for (const s of lt.sections) {
    let line = s.heading ? `${s.heading}: ${s.text}` : s.text;
    if (used + line.length > maxChars) {
      line = line.slice(0, Math.max(0, maxChars - used)) + ' …';
      lines.push(indent + line);
      break;
    }
    used += line.length;
    lines.push(indent + line);
  }
  return lines;
}

// ── Program location ────────────────────────────────────────────────────────

export interface ProgramLocation {
  className: string;
  include: string;
  line: number;
  /** Method name, once resolved from the class include index. */
  method?: string;
}

/**
 * A runtime error names its program location as the class pool include plus line: the class
 * name padded with "=" to 30 characters, "CM" and the method index in hex, e.g.
 * "CLASS_NAME=========CM00B 37". The include is resolved to the method through TMDIR.
 */
export function findProgramLocations(text: string): ProgramLocation[] {
  const out: ProgramLocation[] = [];
  const re = /((?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*)=+(CM[0-9A-F]{3})\s+(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!out.some((o) => o.className === m![1] && o.include === m![2] && o.line === Number(m![3]))) {
      out.push({ className: m[1], include: m[2], line: Number(m[3]) });
    }
  }
  return out;
}

/** Fill in the method name of each location. Best effort: unresolved locations stay as they are. */
export async function resolveProgramLocations(client: BwClient, locs: ProgramLocation[]): Promise<void> {
  const keys = new Map<string, ProgramLocation[]>();
  for (const l of locs) {
    const k = `${l.className}|${parseInt(l.include.slice(2), 16)}`;
    keys.set(k, [...(keys.get(k) ?? []), l]);
  }
  for (const [k, group] of keys) {
    const [cls, idx] = k.split('|');
    try {
      const rows = await queryTable(
        client,
        `SELECT METHODNAME FROM TMDIR WHERE CLASSNAME = '${sqlLiteral(cls)}' AND METHODINDX = ${Number(idx)}`,
        1,
      );
      const name = rows[0]?.METHODNAME;
      if (name) for (const l of group) l.method = name;
    } catch {
      // The include name is still shown; the method is a convenience.
    }
  }
}

export function formatProgramLocation(l: ProgramLocation): string {
  return l.method
    ? `${l.className}->${l.method}, line ${l.line} (include ${l.include})`
    : `${l.className}, include ${l.include}, line ${l.line}`;
}

// ── Process chain node log ──────────────────────────────────────────────────

const MONITORING_BASE = '/sap/bc/http/sap/bw4/v1/monitoring/processchainlogs';
// These endpoints answer "Accept: application/json" with HTTP 415; any type is accepted.
const MONITORING_HEADERS = { Accept: '*/*' };

interface ChainNodeInstance {
  sInstance?: string;
  sReturnedStatus?: string;
  sJobIdentification?: string;
  sDateStart?: string;
  sDateEnd?: string;
}

export interface ChainNode {
  sProcessType?: string;
  sProcessVariant?: string;
  sVariantDescription?: string;
  sLocation?: string;
  sStatus?: string;
  aInstance?: ChainNodeInstance[];
}

export interface NodeLogEntry {
  message?: string;
  severity?: string;
  sMsg?: {
    msgty?: string;
    msgid?: string;
    msgno?: string;
    msgv1?: string;
    msgv2?: string;
    msgv3?: string;
    msgv4?: string;
  };
  longText?: string;
}

interface NodeLogPart {
  log?: NodeLogEntry[];
}

export interface NodeLogResponse {
  joinedLog?: NodeLogPart;
  processLog?: NodeLogPart;
  jobLog?: NodeLogPart;
}

export interface NodeLog {
  node: ChainNode;
  instance: string;
  /** Distinct entries in log order, each with how often it occurs. */
  entries: { entry: NodeLogEntry; count: number }[];
  error?: string;
}

/** How many failed instances of one node are read. A step repeated after an error has several. */
const MAX_INSTANCES_PER_NODE = 3;
const MAX_NODES = 5;

async function readChainRoot(client: BwClient, logId: string): Promise<ChainNode[]> {
  const { body } = await client.rawGet(`${MONITORING_BASE}/${logId.toLowerCase()}`, MONITORING_HEADERS);
  return (JSON.parse(body) as { aNode?: ChainNode[] }).aNode ?? [];
}

/**
 * The node log merges three views — the process log, the job log and a joined log — which
 * overlap but are not subsets of one another: the joined log carries the start, end and
 * status messages of the step that neither part has, and leaves out some of the job log.
 * All three are read, and an entry counts as often as the part that repeats it most.
 */
export function mergeNodeLog(res: NodeLogResponse): { entry: NodeLogEntry; count: number }[] {
  const keyOf = (e: NodeLogEntry) => {
    const s = e.sMsg ?? {};
    return JSON.stringify([s.msgty, s.msgid, s.msgno, s.msgv1, s.msgv2, s.msgv3, s.msgv4, e.message]);
  };
  const merged = new Map<string, { entry: NodeLogEntry; count: number }>();
  for (const part of [res.joinedLog, res.processLog, res.jobLog]) {
    const local = new Map<string, number>();
    for (const e of part?.log ?? []) {
      const k = keyOf(e);
      local.set(k, (local.get(k) ?? 0) + 1);
      if (!merged.has(k)) merged.set(k, { entry: e, count: 0 });
    }
    for (const [k, n] of local) {
      const m = merged.get(k)!;
      m.count = Math.max(m.count, n);
    }
  }
  return [...merged.values()];
}

async function readNodeLog(
  client: BwClient,
  logId: string,
  node: ChainNode,
  inst: ChainNodeInstance,
): Promise<NodeLog> {
  const instance = inst.sInstance ?? '';
  // Instance and job are required: without them the endpoint answers 200 with a different,
  // much shorter log that does not carry the messages of the step.
  const url =
    `${MONITORING_BASE}/${logId.toLowerCase()}/processes/${(node.sLocation ?? '').toLowerCase()}/log` +
    `?instance=${encodeURIComponent(instance.toLowerCase())}` +
    `&jobidentification=${encodeURIComponent(inst.sJobIdentification ?? '')}`;
  try {
    const { body } = await client.rawGet(url, MONITORING_HEADERS);
    return { node, instance, entries: mergeNodeLog(JSON.parse(body) as NodeLogResponse) };
  } catch (err) {
    return { node, instance, entries: [], error: String((err as Error).message).split('\n')[0] };
  }
}

/**
 * Read the step log of the nodes of one chain run.
 *
 * Without `instance`, every failed node is read — the instances of it that failed, or its
 * last one. With `instance`, only the node that ran that instance (a DTP request runs as
 * instance "DTPR__" + request TSN).
 */
export async function readChainNodeLogs(
  client: BwClient,
  logId: string,
  instance?: string,
): Promise<NodeLog[]> {
  const nodes = await readChainRoot(client, logId);
  const picks: { node: ChainNode; inst: ChainNodeInstance }[] = [];
  if (instance) {
    const wanted = instance.toUpperCase();
    for (const node of nodes) {
      const inst = node.aInstance?.find((i) => (i.sInstance ?? '').toUpperCase() === wanted);
      if (inst) picks.push({ node, inst });
    }
  } else {
    for (const node of nodes.filter((n) => n.sStatus === 'negative').slice(0, MAX_NODES)) {
      const all = node.aInstance ?? [];
      const failed = all.filter((i) => i.sReturnedStatus === 'failed');
      const chosen = (failed.length > 0 ? failed : all.slice(-1)).slice(-MAX_INSTANCES_PER_NODE);
      for (const inst of chosen) picks.push({ node, inst });
    }
  }
  return Promise.all(picks.map((p) => readNodeLog(client, logId, p.node, p.inst)));
}

export function isNotableType(msgty: string | undefined, includeWarnings: boolean): boolean {
  const t = (msgty ?? '').toUpperCase();
  return t === 'E' || t === 'A' || t === 'X' || (includeWarnings && t === 'W');
}

function variablesOf(e: NodeLogEntry): string[] {
  const s = e.sMsg ?? {};
  return [s.msgv1, s.msgv2, s.msgv3, s.msgv4].map((v) => (v ?? '').trim());
}

/**
 * Render the notable entries of node logs: message, message number, the variables when the
 * message text does not already show them, the program location a runtime error names, and
 * the long text sections.
 */
export async function formatNodeLogs(
  client: BwClient,
  logs: NodeLog[],
  includeWarnings: boolean,
  indent = '  ',
): Promise<string[]> {
  const locations = new Map<NodeLogEntry, ProgramLocation[]>();
  const allLocs: ProgramLocation[] = [];
  for (const log of logs) {
    for (const { entry } of log.entries) {
      if (!isNotableType(entry.sMsg?.msgty, includeWarnings)) continue;
      const locs = findProgramLocations(variablesOf(entry).join(' '));
      if (locs.length > 0) {
        locations.set(entry, locs);
        allLocs.push(...locs);
      }
    }
  }
  if (allLocs.length > 0) await resolveProgramLocations(client, allLocs);

  const lines: string[] = [];
  for (const log of logs) {
    const n = log.node;
    lines.push('');
    lines.push(
      `── Step Log: ${n.sProcessType ?? ''} ${n.sProcessVariant ?? ''}` +
      `${n.sVariantDescription && n.sVariantDescription !== n.sProcessVariant ? ` (${n.sVariantDescription})` : ''}` +
      ` — instance ${log.instance} ──`,
    );
    if (log.error) {
      lines.push(`${indent}(not readable: ${log.error})`);
      continue;
    }
    const notable = log.entries.filter((e) => isNotableType(e.entry.sMsg?.msgty, includeWarnings));
    for (const { entry, count } of notable) {
      const s = entry.sMsg ?? {};
      const text = entry.message ?? '';
      lines.push(
        `${indent}[${s.msgty ?? ''}] ${s.msgid ?? ''} ${s.msgno ?? ''} — ${text}${count > 1 ? `  (${count}×)` : ''}`,
      );
      const vars = variablesOf(entry);
      if (vars.some((v) => v && !text.includes(v))) {
        lines.push(`${indent}      Variables: ${vars.join(' | ')}`);
      }
      for (const loc of locations.get(entry) ?? []) {
        lines.push(`${indent}      Program:   ${formatProgramLocation(loc)}`);
      }
      lines.push(...formatLongText(parseLongText(entry.longText), `${indent}      `));
    }
    const rest = log.entries.length - notable.length;
    if (notable.length === 0) lines.push(`${indent}(no ${includeWarnings ? 'error or warning' : 'error'} among ${log.entries.length} message(s))`);
    else if (rest > 0) lines.push(`${indent}(${rest} further message(s) of lower severity not shown)`);
  }
  return lines;
}

/** Find the chain run a DTP request ran in. The request runs as process instance "DTPR__" + TSN. */
export async function findChainRunOfRequest(client: BwClient, requestTsn: string): Promise<string | undefined> {
  const rows = await queryTable(
    client,
    `SELECT LOG_ID FROM RSPCPROCESSLOG WHERE INSTANCE = '${sqlLiteral(dtpRequestInstance(requestTsn))}'`,
    5,
  );
  return rows[0]?.LOG_ID || undefined;
}

export function dtpRequestInstance(requestTsn: string): string {
  return `DTPR__${requestTsn}`;
}
