// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: these are the proven write paths of the BW modeling API.
// Changes for coBWeb are marked "coBWeb:". The object adapters in src/objects/ call into this module.

import { BwClient, MEDIA_TYPES, bwSeg, createClientFromEnv, lockSessionHeader, resolveMasterSystem } from '../bw/client.js';
import { logonUser as resolveLogonUser } from '../bw/logon-user.js'; // coBWeb
import { QUERY_ACCEPT_LIST, queryWriteMediaType } from './query.js';
import { parseAggLevelXml } from './planning.js';
import {
  type FilterValue,
  type ResolvedVariable,
  allocateVirtualId,
  buildFilterSelection,
  buildFilterToken,
  escapeRegex,
  escapeXml,
  hasSubComponentId,
  insertSubComponent,
  removeSubComponentById,
  resolveVariable,
  setTokensInSelection,
  stripCheckMarkers,
} from './query_update.js';

/**
 * Planning filters (reusable query components of type Filter on an aggregation level).
 *
 * The document is the query document with the filter as its main component; its selections sit
 * on the main component itself, not in a Qry:filter element, and a variable it uses travels along
 * as a subcomponent before it. Creation follows the modeling tools: the component id from
 * compexist, a creation lock on the component enqueue, the shell posted on /filter/{name}/a.
 * A change locks /filter/{name}/a and writes the whole document back with a PUT.
 */

const FILTER_FALLBACK = 'application/vnd.sap.bw.modeling.filter-v1_9_0+xml';
const FILTER_ACCEPT = 'application/vnd.sap.bw.modeling.filter-v1_8_0+xml, application/vnd.sap.bw.modeling.filter-v1_9_0+xml';
const filterMediaType = () => MEDIA_TYPES['filter'] ?? FILTER_FALLBACK;
const filterPath = (name: string) => `/sap/bw/modeling/filter/${bwSeg(name.toLowerCase())}/a`;

export interface PlanningFilterOperation {
  action: 'set_values' | 'set_variable' | 'remove';
  /** Characteristic; on a CompositeProvider level the bare name is accepted as well as the prefixed one. */
  infoobject?: string;
  values?: FilterValue[];
  variable_name?: string;
}

/** The characteristic of the level a caller means: exact, or the prefixed field of a CompositeProvider. */
export function resolveLevelCharacteristic(requested: string, available: string[]): string {
  const upper = requested.trim().toUpperCase();
  if (available.length === 0) return upper;
  const exact = available.find((a) => a.toUpperCase() === upper);
  if (exact) return exact;
  const bySuffix = available.filter((a) => a.toUpperCase().endsWith(`-${upper}`));
  if (bySuffix.length === 1) return bySuffix[0];
  throw new Error(
    bySuffix.length > 1
      ? `Characteristic "${requested}" is ambiguous on the aggregation level: ${bySuffix.join(', ')}.`
      : `Characteristic "${requested}" is not on the aggregation level. Available: ${available.join(', ')}.`,
  );
}

/** The variable token as the modeling tools write it in a filter. */
const variableToken = (componentId: string) =>
  `<Qry:tokens xsi:type="Qry:SelectionVariable" usageType="asFilter" variable="${componentId}"/>`;

/** The selections of the main component; the ones of an embedded variable sit before it and are left alone. */
function findSelection(doc: string, iobj: string): { start: number; end: number; full: string } | undefined {
  const mainIdx = doc.indexOf('<Qry:mainComponent');
  if (mainIdx < 0) throw new Error('The filter document has no main component.');
  const re = /<Qry:selections\b[^>]*?(?:\/>|>[\s\S]*?<\/Qry:selections>)/g;
  re.lastIndex = mainIdx;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const open = m[0].match(/^<Qry:selections\b[^>]*?\/?>/)?.[0] ?? '';
    if (open.includes(`infoObject="${iobj}"`) && open.includes('usageType="asFilter"')) {
      return { start: m.index, end: m.index + m[0].length, full: m[0] };
    }
  }
  return undefined;
}

function upsertSelection(doc: string, iobj: string, tokens: string): string {
  const existing = findSelection(doc, iobj);
  if (existing) return doc.slice(0, existing.start) + setTokensInSelection(existing.full, tokens) + doc.slice(existing.end);
  const close = doc.lastIndexOf('</Qry:mainComponent>');
  if (close < 0) throw new Error('The filter document has no closing main component.');
  return doc.slice(0, close) + buildFilterSelection(allocateVirtualId(doc), iobj, tokens) + '\n' + doc.slice(close);
}

/** Applies the operations to the document. Exported so the edits can be checked without a system. */
export function applyPlanningFilterOperations(
  doc: string,
  ops: PlanningFilterOperation[],
  variables: Map<string, ResolvedVariable>,
  levelCharacteristics: string[],
): { xml: string; applied: string[] } {
  let xml = doc;
  const applied: string[] = [];
  for (const op of ops) {
    if (op.action === 'set_values') {
      if (!op.infoobject || !op.values?.length) throw new Error('set_values needs infoobject and at least one value.');
      const iobj = resolveLevelCharacteristic(op.infoobject, levelCharacteristics);
      xml = upsertSelection(xml, iobj, op.values.map(buildFilterToken).join('\n  '));
      applied.push(`${iobj}: ${op.values.length} value(s)`);
    } else if (op.action === 'set_variable') {
      if (!op.variable_name) throw new Error('set_variable needs variable_name.');
      const variable = variables.get(op.variable_name.toUpperCase());
      if (!variable) throw new Error(`Variable ${op.variable_name.toUpperCase()} was not resolved.`);
      // The variable names the InfoObject; the level may name it with the provider's prefix.
      const iobj = resolveLevelCharacteristic(op.infoobject ?? variable.characteristic, levelCharacteristics);
      if (!hasSubComponentId(xml, variable.componentId)) xml = insertSubComponent(xml, variable.subComponentXml);
      for (const extra of variable.extraSubComponents) {
        if (!hasSubComponentId(xml, extra.id)) xml = insertSubComponent(xml, extra.xml);
      }
      xml = upsertSelection(xml, iobj, variableToken(variable.componentId));
      applied.push(`${iobj}: variable ${op.variable_name.toUpperCase()}`);
    } else if (op.action === 'remove') {
      if (!op.infoobject) throw new Error('remove needs infoobject.');
      const iobj = resolveLevelCharacteristic(op.infoobject, levelCharacteristics);
      const found = findSelection(xml, iobj);
      if (!found) throw new Error(`The filter has no restriction on ${iobj}.`);
      const varIds = [...found.full.matchAll(/\bvariable="([^"]+)"/g)].map((m) => m[1]);
      xml = xml.slice(0, found.start) + xml.slice(found.end);
      for (const id of varIds) {
        if (!new RegExp(`\\bvariable="${escapeRegex(id)}"`).test(xml)) xml = removeSubComponentById(xml, id);
      }
      applied.push(`${iobj}: removed`);
    } else {
      throw new Error(`Unknown action "${(op as { action: string }).action}". Use set_values, set_variable or remove.`);
    }
  }
  return { xml, applied };
}

function feedMessages(body: string): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  for (const e of body.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)) {
    const type = e[1].match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = e[1].match(/<atom:title>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
    if (type === 'Error') ok = false;
    if (title) messages.push(type ? `${type}: ${title}` : title);
  }
  return { ok, messages };
}

async function levelCharacteristics(client: BwClient, level: string): Promise<string[]> {
  if (!level) return [];
  const res = await client.rawGet(`/sap/bw/modeling/alvl/${bwSeg(level.toLowerCase())}/m`, { Accept: MEDIA_TYPES['alvl'] });
  return parseAggLevelXml(res.body, '').characteristics.map((c) => c.name);
}

async function resolveVariables(client: BwClient, ops: PlanningFilterOperation[]): Promise<Map<string, ResolvedVariable>> {
  const out = new Map<string, ResolvedVariable>();
  for (const op of ops) {
    if (op.action !== 'set_variable' || !op.variable_name) continue;
    const key = op.variable_name.toUpperCase();
    if (!out.has(key)) out.set(key, await resolveVariable(client, op.variable_name));
  }
  return out;
}

export interface UpdatePlanningFilterArgs {
  filter_name: string;
  operations?: PlanningFilterOperation[];
  description?: string;
  transport?: string;
}

/**
 * Set the description of the filter. The read document carries it twice, before and after the
 * entity properties, and the backend keeps the last one; the modeling tools send a single one.
 * Every description of the main component before its first restriction is set, so the texts of
 * the characteristics stay as they are. The entity properties keep theirs, as the modeling tools
 * leave them.
 */
export function setFilterDescription(doc: string, description: string): string {
  const main = doc.indexOf('<Qry:mainComponent');
  if (main < 0) throw new Error('The filter document has no main component.');
  const firstSelection = doc.indexOf('<Qry:selections', main);
  const end = firstSelection < 0 ? doc.lastIndexOf('</Qry:mainComponent>') : firstSelection;
  const head = doc
    .slice(main, end)
    .replace(/(<Qry:description\b[^>]*?\bvalue=")[^"]*(")/g, `$1${escapeXml(description)}$2`);
  return doc.slice(0, main) + head + doc.slice(end);
}

/** bw_update_planning_filter — change the restrictions or the description of a planning filter. */
export async function bwUpdatePlanningFilter(client: BwClient, args: UpdatePlanningFilterArgs): Promise<string> {
  const ops = args.operations ?? [];
  if (ops.length === 0 && args.description === undefined) {
    throw new Error('Nothing to change: pass operations or description.');
  }
  const name = args.filter_name.toUpperCase();
  const path = filterPath(name);
  const read = await client.rawGet(`${path}?forceCacheUpdate=true`, { Accept: FILTER_ACCEPT });
  const level = read.body.match(/<Qry:mainComponent\b[^>]*?\bproviderName="([^"]*)"/)?.[1] ?? '';
  // Resolve everything that needs a request before the lock is taken.
  const variables = await resolveVariables(client, ops);
  const chars = await levelCharacteristics(client, level);
  let { xml, applied } = applyPlanningFilterOperations(stripCheckMarkers(read.body), ops, variables, chars);
  if (args.description !== undefined) {
    xml = setFilterDescription(xml, args.description);
    applied = [...applied, 'description'];
  }

  const csrf = await client.getCsrfToken();
  const lock = await client.rawPost(`${path}?action=lock`, '', { Accept: FILTER_ACCEPT, 'x-csrf-token': csrf, ...lockSessionHeader() });
  const handle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${lock.body}`);
  let result: { ok: boolean; messages: string[] };
  try {
    const corr = args.transport ? `corrNr=${encodeURIComponent(args.transport)}&` : '';
    const timestamp = lock.headers['timestamp'] ?? read.headers['timestamp'];
    const res = await client.rawPut(`${path}?${corr}lockHandle=${handle}`, xml, {
      'Content-Type': `application/xml, ${filterMediaType()}`,
      Accept: filterMediaType(),
      'x-csrf-token': await client.getCsrfToken(),
      ...(timestamp ? { timestamp } : {}),
    });
    result = feedMessages(res.body);
  } finally {
    await client.rawPost(`${path}?action=unlock`, '', { Accept: FILTER_ACCEPT, 'x-csrf-token': await client.getCsrfToken() }).catch(() => {/* ignore */});
  }
  return JSON.stringify({
    success: result.ok,
    filter_name: name,
    aggregation_level: level,
    changes: applied,
    messages: result.messages,
    ...(result.ok ? {} : { note: 'BW reported errors; the filter may have been saved as sent. Read it with bw_get_planning_filter.' }),
  }, null, 2);
}

export interface CreatePlanningFilterArgs {
  filter_name: string;
  aggregation_level: string;
  description: string;
  operations?: PlanningFilterOperation[];
  package?: string;
  transport?: string;
}

/** bw_create_planning_filter — create a planning filter on an aggregation level, with its restrictions. */
export async function bwCreatePlanningFilter(client: BwClient, args: CreatePlanningFilterArgs): Promise<string> {
  const name = args.filter_name.trim().toUpperCase();
  const lower = name.toLowerCase();
  const level = args.aggregation_level.trim().toUpperCase();
  const pkg = args.package ?? '$TMP';
  // Fail on a bad restriction before anything is created.
  const ops = args.operations ?? [];
  if (ops.length) {
    const variables = await resolveVariables(client, ops);
    applyPlanningFilterOperations(
      '<Qry:queryResource><Qry:mainComponent></Qry:mainComponent></Qry:queryResource>',
      ops,
      variables,
      await levelCharacteristics(client, level),
    );
  }

  const exist = await client.rawGet(`/sap/bw/modeling/queryint?action=compexist&compid=${encodeURIComponent(lower)}&type=ELEM`, { 'bwmt-level': '50' });
  if (exist.headers['compexist'] === 'true') throw new Error(`A component named ${name} already exists.`);
  const uid = exist.headers['elemuid'];
  if (!uid) throw new Error(`compexist returned no ELEMUID for ${name}.`);

  const language = process.env.BW_LANGUAGE ?? 'DE';
  const responsible = await resolveLogonUser(client);
  const masterSystem = await resolveMasterSystem(client);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const desc = escapeXml(args.description);
  const shell =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">\n` +
    `  <Qry:schemaVersion>1.0</Qry:schemaVersion>\n` +
    `  <Qry:mainComponent xsi:type="Qry:Filter" id="${uid}" componentVersion="101" providerName="${level}" reusable="true" technicalName="${name}">\n` +
    `    <Qry:description default="false" value="${desc}"/>\n` +
    `    <Qry:entityProperties adtcore:changedAt="${now}" adtcore:changedBy="${responsible}" adtcore:createdAt="${now}" adtcore:createdBy="${responsible}" ` +
    `adtcore:description="${desc}" adtcore:language="${language}" adtcore:name="${name}" adtcore:type="SOB" adtcore:masterLanguage="${language}" ` +
    `adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}"/>\n` +
    `  </Qry:mainComponent>\n` +
    `</Qry:queryResource>`;

  const enq = `/sap/bw/modeling/comp/enq/${bwSeg(lower)}`;
  const lock = await client.rawPost(`${enq}?action=lock&compuid=${uid}`, '', {
    activity_context: 'CREA',
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const handle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in the creation lock response:\n${lock.body}`);
  let created: { ok: boolean; messages: string[] };
  try {
    // A fresh session, as for the other query components: the creating session's buffer would
    // otherwise serve a stale document afterwards.
    const fresh = createClientFromEnv();
    const corr = args.transport ? `&corrNr=${encodeURIComponent(args.transport)}` : '';
    const res = await fresh.rawPost(`${filterPath(name)}?compuid=${uid}&lockHandle=${handle}${corr}`, shell, {
      'Development-Class': pkg,
      ELEMUID: uid,
      'Content-Type': filterMediaType(),
      Accept: filterMediaType(),
      'x-csrf-token': await fresh.getCsrfToken(),
    });
    created = feedMessages(res.body);
  } finally {
    await client.rawPost(`${enq}?action=unlock&compuid=${uid}`, '', { 'x-csrf-token': await client.getCsrfToken() }).catch(() => {/* ignore */});
  }
  if (!created.ok) {
    return JSON.stringify({ success: false, filter_name: name, messages: created.messages }, null, 2);
  }
  if (!ops.length) {
    return JSON.stringify({ success: true, filter_name: name, aggregation_level: level, package: pkg, messages: created.messages }, null, 2);
  }
  const update = JSON.parse(await bwUpdatePlanningFilter(createClientFromEnv(), { filter_name: name, operations: ops, transport: args.transport }));
  return JSON.stringify({ ...update, package: pkg, messages: [...created.messages, ...update.messages] }, null, 2);
}
