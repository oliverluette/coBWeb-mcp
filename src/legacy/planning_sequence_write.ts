// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: these are the proven write paths of the BW modeling API.
// Changes for coBWeb are marked "coBWeb:". The object adapters in src/objects/ call into this module.

import { BwClient, MEDIA_TYPES, bwSeg, createClientFromEnv, lockSessionHeader, resolveMasterSystem } from '../bw/client.js';
import { logonUser as resolveLogonUser } from '../bw/logon-user.js'; // coBWeb

/**
 * Planning sequences (TLOGO PLSQ).
 *
 * Creation follows the modeling tools: a shell (name, description, InfoArea) posted under a
 * creation lock, then the whole sequence written to the active version with a PUT under a second
 * lock. A change is the same PUT. The steps are <step> elements in execution order; the GET
 * returns their references in a short form, the PUT carries them as relative paths, and a filter
 * is referenced by its component id as well as by its name.
 */

const PLSQ_FALLBACK = 'application/vnd.sap.bw.modeling.plsq-v1_0_0+xml';
const plsqMediaType = () => MEDIA_TYPES['plsq'] ?? PLSQ_FALLBACK;
const plsqPath = (name: string) => `/sap/bw/modeling/plsq/${bwSeg(name.toLowerCase())}/a`;
const FILTER_ACCEPT = 'application/vnd.sap.bw.modeling.filter-v1_8_0+xml, application/vnd.sap.bw.modeling.filter-v1_9_0+xml';

export interface SequenceStepInput {
  /** planning_function runs a function; input_template only opens the filter for manual input. */
  type: 'planning_function' | 'input_template';
  aggregation_level: string;
  planning_function?: string;
  filter: string;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One step as the modeling tools write it in the PUT. */
export function stepXml(step: SequenceStepInput, filterId: string): string {
  const alvl = step.aggregation_level.trim().toLowerCase();
  const filter = step.filter.trim();
  const base =
    `alvl="../../../alvl/${alvl}/a/model.alvl#//" ` +
    `filter="../../../filter/${filter.toLowerCase()}/A/model.filter#${filterId}" filterName="${esc(filter.toUpperCase())}"`;
  if (step.type === 'input_template') return `<step ${base} type="1"/>`;
  if (step.type !== 'planning_function') throw new Error(`Step type "${step.type}" is neither planning_function nor input_template.`);
  if (!step.planning_function) throw new Error('A planning_function step needs planning_function.');
  return `<step ${base} planningService="../../../plse/${step.planning_function.trim().toLowerCase()}/a/model.plse#//" type="2"/>`;
}

/** The sequence as read, with its steps and optionally its description replaced. */
export function sequenceBody(read: string, steps: string[], description?: string): string {
  let xml = read.replace(/<step\b[^>]*?(?:\/>|>[\s\S]*?<\/step>)/g, '');
  if (description !== undefined) {
    xml = xml.replace(/(<description\b[^>]*?\blabel=")[^"]*(")/, `$1${esc(description)}$2`);
  }
  const close = xml.lastIndexOf('</');
  if (close < 0) throw new Error('Unexpected planning sequence document.');
  return xml.slice(0, close) + steps.join('') + xml.slice(close);
}

/** A filter is referenced by the component id of its main component. */
async function filterIds(client: BwClient, steps: SequenceStepInput[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const s of steps) {
    const name = s.filter?.trim().toUpperCase();
    if (!name) throw new Error('Every step needs a filter.');
    if (ids.has(name)) continue;
    const res = await client.rawGet(`/sap/bw/modeling/filter/${bwSeg(name.toLowerCase())}/a`, { Accept: FILTER_ACCEPT });
    const id = res.body.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
    if (!id) throw new Error(`Filter ${name} has no component id.`);
    ids.set(name, id);
  }
  return ids;
}

function feed(body: string): { ok: boolean; messages: string[] } {
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

async function lock(client: BwClient, path: string, create: boolean) {
  const res = await client.rawPost(`${path}?action=lock`, '', {
    Accept: plsqMediaType(),
    'x-csrf-token': await client.getCsrfToken(),
    ...(create ? { activity_context: 'CREA' } : {}),
    ...lockSessionHeader(),
  });
  const handle = res.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${res.body}`);
  return { handle, timestamp: res.headers['timestamp'] };
}

async function unlock(client: BwClient, path: string) {
  await client
    .rawPost(`${path}?action=unlock`, '', { Accept: plsqMediaType(), 'Content-Type': plsqMediaType(), 'x-csrf-token': await client.getCsrfToken() })
    .catch(() => {/* ignore */});
}

async function writeSequence(
  client: BwClient,
  name: string,
  steps: SequenceStepInput[] | undefined,
  description: string | undefined,
  transport: string | undefined,
): Promise<{ ok: boolean; messages: string[] }> {
  const path = plsqPath(name);
  const read = await client.rawGet(path, { Accept: plsqMediaType() });
  let stepsXml: string[];
  if (steps) {
    const ids = await filterIds(client, steps);
    stepsXml = steps.map((s) => stepXml(s, ids.get(s.filter.trim().toUpperCase())!));
  } else {
    // Only the description changes: the steps go back in the form the PUT expects.
    stepsXml = [...read.body.matchAll(/<step\b([^>]*?)\/>/g)].map((m) => {
      const a = (n: string) => m[1].match(new RegExp(`\\b${n}="([^"]*)"`))?.[1] ?? '';
      const bare = (ref: string) => ref.slice(0, ref.indexOf('.') >= 0 ? ref.indexOf('.') : undefined);
      const input: SequenceStepInput = {
        type: a('type') === '1' ? 'input_template' : 'planning_function',
        aggregation_level: bare(a('alvl')),
        planning_function: bare(a('planningService')) || undefined,
        filter: a('filterName'),
      };
      return stepXml(input, a('filter'));
    });
  }
  const body = sequenceBody(read.body, stepsXml, description);
  // A session that has written a sequence answers its next lock with HTTP 500, so every write runs
  // in a session of its own, as the query tools do. Under principal propagation it is the same user.
  const writer = createClientFromEnv();
  const second = await lock(writer, path, false);
  try {
    const corr = transport ? `corrNr=${encodeURIComponent(transport)}&` : '';
    const res = await writer.rawPut(`${path}?${corr}lockHandle=${second.handle}`, body, {
      'Content-Type': `application/xml, ${plsqMediaType()}`,
      Accept: plsqMediaType(),
      'x-csrf-token': await writer.getCsrfToken(),
      ...(second.timestamp ? { timestamp: second.timestamp } : {}),
    });
    return feed(res.body);
  } finally {
    await unlock(writer, path);
  }
}

export interface CreatePlanningSequenceArgs {
  sequence_name: string;
  description: string;
  steps: SequenceStepInput[];
  info_area?: string;
  package?: string;
  transport?: string;
}

/** bw_create_planning_sequence — create a planning sequence with its steps. */
export async function bwCreatePlanningSequence(client: BwClient, args: CreatePlanningSequenceArgs): Promise<string> {
  const name = args.sequence_name.trim().toUpperCase();
  if (!args.steps?.length) throw new Error('A planning sequence needs at least one step.');
  // Validate the steps before anything is written.
  for (const s of args.steps) stepXml(s, 'X');
  const pkg = args.package ?? '$TMP';
  const path = plsqPath(name);

  let infoArea = args.info_area?.trim().toUpperCase();
  if (!infoArea) {
    const alvl = await client.rawGet(`/sap/bw/modeling/alvl/${bwSeg(args.steps[0].aggregation_level.toLowerCase())}/a`, { Accept: MEDIA_TYPES['alvl'] });
    infoArea = alvl.body.match(/<infoArea>([^<]+)<\/infoArea>/)?.[1]?.trim();
    if (!infoArea) throw new Error('Could not read the InfoArea of the first aggregation level; pass info_area.');
  }
  const language = process.env.BW_LANGUAGE ?? 'DE';
  const shell =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Plsq:planningSequence xmlns:Plsq="http://www.sap.com/bw/modeling/BwPlanningSequence.ecore" xmlns:adtcore="http://www.sap.com/adt/core" name="${name}">\n` +
    `  <description label="${esc(args.description)}" textType="3"/>\n` +
    `  <tlogoProperties adtcore:language="${language}" adtcore:name="${name}" adtcore:type="PLSQ" adtcore:masterLanguage="${language}" ` +
    `adtcore:masterSystem="${await resolveMasterSystem(client)}" adtcore:responsible="${await resolveLogonUser(client)}">\n` +
    `    <infoArea>${infoArea}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `</Plsq:planningSequence>`;

  const first = await lock(client, path, true);
  let created: { ok: boolean; messages: string[] };
  try {
    const corr = args.transport ? `&corrNr=${encodeURIComponent(args.transport)}` : '';
    const res = await client.rawPost(`${path}?lockHandle=${first.handle}${corr}`, shell, {
      'Development-Class': pkg,
      'Content-Type': plsqMediaType(),
      Accept: plsqMediaType(),
      'x-csrf-token': await client.getCsrfToken(),
    });
    created = feed(res.body);
  } finally {
    await unlock(client, path);
  }
  if (!created.ok) return JSON.stringify({ success: false, sequence_name: name, messages: created.messages }, null, 2);

  const saved = await writeSequence(client, name, args.steps, undefined, args.transport);
  return JSON.stringify({
    success: saved.ok,
    sequence_name: name,
    info_area: infoArea,
    package: pkg,
    steps: args.steps.length,
    messages: [...created.messages, ...saved.messages],
    ...(saved.ok ? {} : { note: 'The sequence was created, but its steps were refused; it exists without them.' }),
  }, null, 2);
}

export interface UpdatePlanningSequenceArgs {
  sequence_name: string;
  steps?: SequenceStepInput[];
  description?: string;
  transport?: string;
}

/** bw_update_planning_sequence — replace the steps of a planning sequence and/or change its description. */
export async function bwUpdatePlanningSequence(client: BwClient, args: UpdatePlanningSequenceArgs): Promise<string> {
  if (!args.steps && args.description === undefined) throw new Error('Nothing to change: pass steps or description.');
  if (args.steps && args.steps.length === 0) throw new Error('A planning sequence needs at least one step.');
  if (args.steps) for (const s of args.steps) stepXml(s, 'X');
  const name = args.sequence_name.trim().toUpperCase();
  const saved = await writeSequence(client, name, args.steps, args.description, args.transport);
  return JSON.stringify({
    success: saved.ok,
    sequence_name: name,
    ...(args.steps ? { steps: args.steps.length } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    messages: saved.messages,
  }, null, 2);
}
