/**
 * CompositeProvider (HCPR): union or join over InfoProviders.
 *
 * A create is one call: the shell is created, each input is attached with its field mappings
 * (all fields 1:1 unless `fields` narrows them), the join condition is set for a join, and the
 * object is left locked for the activation. The legacy write paths handle the details that make
 * this work (field-name prefixes of the sources, technical fields, name usage, field groups).
 */
import { bwSeg, freshRead, type BwClient } from '../bw/client.js';
import { validateArgs } from '../format/validate.js';
import { ToolError } from '../format/errors.js';
import {
  HCPR_ACCEPT,
  bwCreateCompositeProvider,
  bwUpdateCompositeProviderInput,
  bwUpdateCompositeProviderJoin,
  bwUpdateCompositeProviderMapping,
  bwUpdateCompositeProviderFields,
  bwUpdateCompositeProviderGroup,
  bwUpdateCompositeProviderSettings,
  extractProviderNameFromInput,
  fetchCompositeSourceFields,
  type FieldMapping,
} from '../legacy/composite_provider.js';
import { bwDelete } from '../legacy/delete.js';
import { planningPart } from './planning.js';
import { bwUpdateCompositeProvider } from '../legacy/composite_provider_update.js';
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

const INPUT: JsonObject = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    type: { type: 'string', enum: ['ADSO', 'HCPR', 'IOBJ'] },
    fields: { type: 'array', items: { type: 'string' } },
  },
  required: ['provider'],
  additionalProperties: false,
};
const JOIN: JsonObject = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['inner', 'left_outer'] },
    on: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', properties: { left: { type: 'string' }, right: { type: 'string' } }, required: ['left', 'right'], additionalProperties: false },
    },
  },
  required: ['on'],
  additionalProperties: false,
};
const NAME_LIST: JsonObject = { type: 'array', items: { type: 'string' } };
const INPUT_MAPPING: JsonObject = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    fields: NAME_LIST,
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { target: { type: 'string' }, source: { type: 'string' }, constant: { type: 'string' } },
        required: ['target'],
        additionalProperties: false,
      },
    },
  },
  required: ['provider'],
  additionalProperties: false,
};
const FIELD_PROPERTY: JsonObject = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    group: { type: 'string' },
    name_usage: { type: 'string', enum: ['direct', 'unique_name'] },
    aggregation: { type: 'string', enum: ['SUM', 'MAX', 'MIN', 'NO1', 'NO2', 'NOP'] },
  },
  required: ['field'],
  additionalProperties: false,
};
const GROUP: JsonObject = {
  type: 'object',
  properties: { name: { type: 'string' }, label: { type: 'string' }, rename_to: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};
const CREATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    info_area: { type: 'string' },
    view: { type: 'string', enum: ['union', 'join'] },
    inputs: { type: 'array', minItems: 1, items: INPUT },
    join: JOIN,
    stackable: { type: 'boolean' },
    copy_from: { type: 'string' },
  },
  required: ['description', 'info_area'],
  additionalProperties: false,
};
const UPDATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    info_area: { type: 'string' },
    view: { type: 'string', enum: ['union', 'join'] },
    inputs: { type: 'array', items: INPUT },
    inputs_add: { type: 'array', items: INPUT },
    inputs_remove: { type: 'array', items: { type: 'string' } },
    input_mappings: { type: 'array', items: INPUT_MAPPING },
    fields_add: NAME_LIST,
    fields_remove: NAME_LIST,
    field_properties: { type: 'array', items: FIELD_PROPERTY },
    groups: { type: 'array', items: GROUP },
    join: JOIN,
    stackable: { type: 'boolean' },
    copy_from: { type: 'string' },
    default_node: { type: 'string' },
  },
  additionalProperties: false,
};

interface InputSpec {
  provider: string;
  type: string;
  fields?: string[];
}

function inputsOf(v: unknown): InputSpec[] {
  if (!Array.isArray(v)) return [];
  return v.map((i: JsonObject) => ({
    provider: String(i.provider).toUpperCase(),
    type: String(i.type ?? 'ADSO').toUpperCase(),
    fields: Array.isArray(i.fields) ? i.fields.map((f) => String(f).toUpperCase()) : undefined,
  }));
}

export interface HcprField {
  name: string;
  infoObject?: string;
  dataType: string;
  size: string;
  label: string;
  keyFigure: boolean;
  /** Field group (dimension) without the decoration. */
  group?: string;
  /** "direct": the InfoObject answers by its own name; "unique_name": by <prefix>-<FIELD>. */
  nameUsage?: 'direct' | 'unique_name';
  /** Aggregation of a key figure field (SUM, MAX, MIN, NO1, NO2, NOP). */
  aggregation?: string;
}

export interface HcprModel {
  name: string;
  label: string;
  view: 'union' | 'join' | 'unknown';
  infoArea?: string;
  package?: string;
  status?: string;
  fields: HcprField[];
  inputs: { alias: string; provider: string; mappings: number; targets: string[]; pairs: { target: string; source?: string; constant?: string }[] }[];
  joins: { left: string; right: string; type: string; on: { left: string; right: string }[] }[];
  stackable: boolean;
  /** The default node by its name (U1, J1, …). */
  defaultNode?: string;
  nodes: string[];
}

export function parseHcpr(name: string, xml: string): HcprModel {
  const attr = (src: string, a: string) => src.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
  const viewType = xml.match(/<viewNode\b[^>]*\bxsi:type="([^"]*)"/)?.[1]?.split(':').pop();
  const firstInput = xml.indexOf('<input');
  const head = firstInput === -1 ? xml : xml.slice(0, firstInput);
  const fields: HcprField[] = [];
  for (const m of head.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)) {
    const [, attrs, body] = m;
    const inline = body.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
    const length = attr(inline, 'length');
    const precision = attr(inline, 'precision');
    const scale = attr(inline, 'scale');
    const aggregation = attr(attrs, 'aggregationBehavior');
    const semantic = attr(inline, 'semanticType');
    fields.push({
      name: attr(attrs, 'name') ?? '',
      infoObject: attr(attrs, 'infoObjectName'),
      dataType: attr(inline, 'name') ?? '',
      size: precision && precision !== '0' ? `${precision}${scale ? `,${scale}` : ''}` : length ?? '',
      label: xmlDecode(
        body.match(/<localProperties\b[^>]*>\s*<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1] ??
          body.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ??
          '',
      ),
      keyFigure: (aggregation !== undefined && aggregation !== 'NONE') || semantic === 'amount' || semantic === 'quantity',
      group: attr(attrs, 'dimension')?.replace(/^#\/\/\//, '').replace(/\u00a7$/, ''),
      nameUsage: attr(attrs, 'infoObjectName') ? (attr(inline, 'globalElementName') ? 'direct' : 'unique_name') : undefined,
      aggregation: aggregation && aggregation !== 'NONE' ? aggregation : undefined,
    });
  }
  const inputs = [...xml.matchAll(/<input\b([^>]*)>([\s\S]*?)<\/input>/g)].map((m) => ({
    alias: attr(m[1], 'alias') ?? '',
    provider: extractProviderNameFromInput(m[0]) ?? '?',
    mappings: (m[2].match(/<mapping\b/g) ?? []).length,
    targets: [...m[2].matchAll(/<mapping\b[^>]*\btargetName="([^"]+)"/g)].map((t) => t[1].toUpperCase()),
    pairs: [...m[2].matchAll(/<mapping\b([^>]*)\/?>/g)].map((t) => {
      const constant = /ConstantElementMapping/.test(t[1]) ? xmlDecode(attr(t[1], 'value') ?? '') : undefined;
      const source = attr(t[1], 'sourceName');
      return { target: (attr(t[1], 'targetName') ?? '').toUpperCase(), ...(constant !== undefined ? { constant } : source ? { source: source.replace(/^.*-/, '') } : {}) };
    }),
  }));
  // A key is addressed by its name on the source, which a field-based source prefixes ("4X-FIELD").
  const bare = (v: string) => v.trim().toUpperCase().replace(/^.*-/, '');
  const joins = [...xml.matchAll(/<join\b([^>]*?)(?:\/>|>([\s\S]*?)<\/join>)/g)].map((m) => {
    const body = m[2] ?? '';
    const lefts = [...body.matchAll(/<leftElementName>([^<]*)<\/leftElementName>/g)].map((x) => bare(x[1]));
    const rights = [...body.matchAll(/<rightElementName>([^<]*)<\/rightElementName>/g)].map((x) => bare(x[1]));
    return {
      left: (attr(m[1], 'leftInput') ?? '').split('/').pop() ?? '',
      right: (attr(m[1], 'rightInput') ?? '').split('/').pop() ?? '',
      type: attr(m[1], 'joinType') ?? '',
      on: lefts.map((l, i) => ({ left: l, right: rights[i] ?? '' })),
    };
  });
  const loc = locationFromXml(xml);
  return {
    name: name.toUpperCase(),
    label: xmlDecode(xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
    view: viewType === 'Union' ? 'union' : viewType === 'JoinNode' ? 'join' : 'unknown',
    infoArea: loc.infoArea,
    package: loc.package,
    status: documentStatus(xml),
    fields,
    inputs,
    joins,
    stackable: attr(xml.match(/<Composite:compositeView\b[^>]*>/)?.[0] ?? '', 'stackable') === 'true',
    defaultNode: attr(xml.match(/<Composite:compositeView\b[^>]*>/)?.[0] ?? '', 'defaultNode')?.replace(/^#\/\/\//, ''),
    nodes: [...xml.matchAll(/<viewNode\b[^>]*\bname="([^"]+)"/g)].map((n) => n[1]),
  };
}

export function summarizeHcpr(m: HcprModel, part?: string, detail: 'summary' | 'full' = 'summary'): string {
  const full = detail === 'full';
  const head = `HCPR ${m.name} "${m.label}" · ${statusText(m.status)} · ${m.view}${m.stackable ? ' · stackable' : ''}${m.nodes.length > 1 && m.defaultNode ? ` · default node ${m.defaultNode}` : ''} · InfoArea ${m.infoArea ?? '?'} · package ${m.package ?? '?'}`;
  const inputs = [`Inputs (${m.inputs.length}):`];
  for (const i of m.inputs) {
    const constants = i.pairs.filter((x) => x.constant !== undefined);
    inputs.push(`  ${i.alias.padEnd(12)} ${i.provider}  ${i.mappings} mappings${constants.length && !full ? `, ${constants.length} constant` : ''}`);
    if (!full) continue;
    // Only what differs from a 1:1 mapping is listed.
    const special = i.pairs.filter((x) => x.constant !== undefined || (x.source && x.source.toUpperCase() !== x.target));
    for (const x of special) inputs.push(`    ${x.target} ← ${x.constant !== undefined ? `"${x.constant}"` : x.source}`);
    const unmapped = m.fields.filter((f) => !i.targets.includes(f.name.toUpperCase())).map((f) => f.name);
    if (unmapped.length) inputs.push(`    not mapped: ${unmapped.join(', ')}`);
  }
  for (const j of m.joins) inputs.push(`  join ${j.type} ${j.left} ⋈ ${j.right}`);
  const n = Math.max(4, ...m.fields.map((f) => f.name.length));
  const fields = [
    `Fields (${m.fields.length}, key figures marked #):`,
    ...m.fields.map((f) => {
      const extra = [f.aggregation && f.aggregation !== 'SUM' ? `[aggregation ${f.aggregation}]` : '', ...(full ? [f.group ? `[group ${f.group}]` : '', f.nameUsage === 'unique_name' ? '[unique name]' : ''] : [])].filter(Boolean).join(' ');
      return `  ${f.keyFigure ? '#' : ' '} ${f.name.padEnd(n)}  ${`${f.dataType} ${f.size}`.trim().padEnd(10)}  ${f.label}${extra ? `  ${extra}` : ''}`.trimEnd();
    }),
  ];
  const p = part?.toLowerCase();
  if (p === 'inputs') return [head, ...inputs].join('\n');
  if (p === 'fields') return [head, ...fields].join('\n');
  return [head, ...inputs, ...fields].join('\n');
}

async function readXml(name: string): Promise<string> {
  return (await freshRead(`/sap/bw/modeling/hcpr/${bwSeg(name.toLowerCase())}/m`, HCPR_ACCEPT)).body;
}

async function addInput(client: BwClient, name: string, input: InputSpec, transport?: string): Promise<{ alias: string; handle: string }> {
  const r = JSON.parse(
    await bwUpdateCompositeProviderInput(client, name, 'add_input', {
      input: { providerName: input.provider, providerType: input.type, mappings: input.fields?.map((f) => ({ target: f })) },
      transport,
    }),
  ) as { success: boolean; message?: string; input_alias?: string; lock_handle?: string };
  if (!r.success) throw new ToolError('backend', r.message ?? `adding input ${input.provider} failed`);
  return { alias: r.input_alias ?? '', handle: r.lock_handle ?? '' };
}

async function setMappings(client: BwClient, name: string, alias: string, input: InputSpec, transport?: string, mappings?: FieldMapping[]): Promise<string> {
  const r = JSON.parse(
    await bwUpdateCompositeProviderMapping(client, name, alias, mappings ?? input.fields?.map((f) => ({ target: f })) ?? [], transport),
  ) as { success: boolean; message?: string; lock_handle?: string };
  if (!r.success) throw new ToolError('backend', r.message ?? `mapping input ${input.provider} failed`);
  return r.lock_handle ?? '';
}

function joinPairs(join: JsonObject): { left: string; right: string }[] {
  return (join.on as JsonObject[]).map((p) => ({ left: String(p.left).toUpperCase(), right: String(p.right).toUpperCase() }));
}

/** Longest element name BW accepts in a CompositeProvider. */
const MAX_ELEMENT_NAME = 12;

/**
 * Mappings of the right input of a join: join fields go onto the left input's target fields,
 * other fields keep their name unless it is taken, then get a suffix _0, _1, …
 */
export async function rightJoinMappings(
  input: InputSpec,
  on: { left: string; right: string }[],
  existing: Set<string>,
  sourceFields: (provider: string) => Promise<{ fields: { defaultTargetName: string; isMetaObject: boolean }[] }> = fetchCompositeSourceFields,
): Promise<FieldMapping[]> {
  const names =
    input.fields ??
    (await sourceFields(input.provider)).fields.filter((f) => !f.isMetaObject && f.defaultTargetName !== '1ROWCOUNT').map((f) => f.defaultTargetName.toUpperCase());
  const keyTarget = new Map(on.map((p) => [p.right, p.left]));
  const used = new Set(existing);
  const out: FieldMapping[] = [];
  for (const n of [...names, ...[...keyTarget.keys()].filter((k) => !names.includes(k))]) {
    let target = keyTarget.get(n);
    if (!target) {
      target = n;
      if (used.has(target)) {
        const stem = n.slice(0, MAX_ELEMENT_NAME - 2);
        let i = 0;
        while (used.has(`${stem}_${i}`)) i++;
        target = `${stem}_${i}`;
      }
    }
    used.add(target);
    out.push({ target, source: n });
  }
  return out;
}

async function setJoin(client: BwClient, name: string, left: string, right: string, join: JsonObject, transport?: string): Promise<string> {
  const on = joinPairs(join);
  const r = JSON.parse(
    await bwUpdateCompositeProviderJoin(client, name, left, right, on, { joinType: join.type === 'left_outer' ? 'leftOuter' : 'inner', transport }),
  ) as { success: boolean; message?: string; lock_handle?: string };
  if (!r.success) throw new ToolError('backend', r.message ?? 'setting the join failed');
  return r.lock_handle ?? '';
}

export const hcprAdapter: ObjectAdapter = {
  type: 'HCPR',
  label: 'CompositeProvider',
  activationType: 'hcpr',

  describe(action) {
    const lines =
      action === 'create'
        ? [
            'HCPR create spec',
            '  description   text, max 60                                   (required)',
            '  info_area     InfoArea name                                  (required)',
            '  view          union (default) | join',
            '  inputs        list of {provider, type, fields}               (required)',
            '    provider    InfoProvider name, e.g. an ADSO',
            '    type        ADSO (default) | HCPR | IOBJ',
            '    fields      fields to take over; omit to map all fields 1:1',
            '  join          for view=join with exactly two inputs:',
            '    type        inner (default) | left_outer',
            '    on          list of {left, right}: field names on the first and second provider',
            'Fields of the inputs become CompositeProvider fields with the same name. In a join the',
            'join fields of the second input share the first input\'s field; other names that are',
            'taken get a suffix _0, _1, … The object is activated in the same call (activate=true).',
            '  stackable     true | false (default false)',
            '  copy_from     another CompositeProvider: BW copies view, inputs, mappings and joins',
            '                (then without view, inputs, join)',
            'Examples',
            '  {"action":"create","type":"HCPR","name":"ZSALESCP","spec":{"description":"Sales","info_area":"ZSALES","inputs":[{"provider":"ZSALES01"},{"provider":"ZSALES02"}]}}',
            '  {"action":"create","type":"HCPR","name":"ZSALESJ","spec":{"description":"Sales with plan","info_area":"ZSALES","view":"join","inputs":[{"provider":"ZSALES01"},{"provider":"ZPLAN01"}],"join":{"on":[{"left":"ZCUSTOMER","right":"ZCUSTOMER"}]}}}',
          ]
        : [
            'HCPR update spec (only the named properties change)',
            '  description     text, max 60',
            '  inputs_add      list of {provider, type, fields}, as in create',
            '  inputs_remove   provider names whose inputs are removed',
            '  input_mappings  list of {provider, fields | mappings}: replaces the mappings of that input;',
            '                  fields = target names mapped 1:1, [] = all fields 1:1;',
            '                  mappings = list of {target, source | constant}',
            '  fields_add      InfoObject names: new fields, mapped from every input that has them',
            '  fields_remove   field names',
            '  field_properties list of {field, group, name_usage, aggregation}: group = a declared field group;',
            '                  name_usage direct (queries see the InfoObject name) | unique_name;',
            '                  aggregation of a key figure without InfoObject: SUM | MAX | MIN | NO1 (X if more than one record)',
            '                  | NO2 (X if more than one value) | NOP (X if more than one value other than 0)',
            '  groups          list of {name, label, rename_to}: creates, relabels or renames a field group',
            '  join            {type, on} as in create: replaces the join condition of a join',
            '  stackable       true | false',
            '  default_node    the node queries read (U1, J1, …; only providers with several nodes)',
            'The view type cannot change.',
            'Example',
            '  {"action":"update","type":"HCPR","name":"ZSALESCP","spec":{"inputs_add":[{"provider":"ZSALES03"}]}}',
          ];
    return lines.join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const s = spec ?? {};
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, s).errors;
    if (action === 'create' && !/^[A-Z][A-Z0-9_]{1,9}$/i.test(name)) errors.push('name: 2–10 characters A–Z, 0–9, _, starting with a letter');
    if (typeof s.description === 'string' && s.description.length > 60) errors.push('description: at most 60 characters');
    if (action === 'create' && s.copy_from !== undefined) {
      if (s.inputs !== undefined || s.join !== undefined || s.view !== undefined) errors.push('copy_from: the template brings view, inputs and join; leave them out');
    } else if (action === 'create') {
      if (s.inputs === undefined) errors.push('inputs: required unless copy_from is given');
      const join = s.view === 'join';
      const n = Array.isArray(s.inputs) ? s.inputs.length : 0;
      if (join && n !== 2) errors.push('inputs: a join needs exactly two inputs');
      if (join && s.join === undefined) errors.push('join: required for view=join');
      if (!join && s.join !== undefined) errors.push('join: only for view=join');
      const providers = inputsOf(s.inputs).map((i) => i.provider);
      if (new Set(providers).size !== providers.length) errors.push('inputs: a provider is listed twice');
    }
    return errors;
  },

  dependsOn(action, _name, spec) {
    if (action === 'delete' || !spec) return [];
    const refs: ObjectRef[] = [];
    if (typeof spec.info_area === 'string') refs.push({ type: 'AREA', name: spec.info_area.toUpperCase() });
    for (const i of [...inputsOf(spec.inputs), ...inputsOf(spec.inputs_add)]) {
      if (i.type === 'ADSO' || i.type === 'HCPR' || i.type === 'IOBJ') refs.push({ type: i.type, name: i.provider });
    }
    if (typeof spec.copy_from === 'string') refs.push({ type: 'HCPR', name: spec.copy_from.toUpperCase() });
    return refs;
  },

  targetInfoArea(_name, spec) {
    return typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
  },

  async locate(_client, name) {
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
    const m = parseHcpr(name, xml);
    if (part?.toLowerCase() === 'planning') return `${summarizeHcpr(m, part, 'summary').split('\n')[0]}\n${await planningPart(_client, name)}`;
    return summarizeHcpr(m, part, detail === 'full' ? 'full' : 'summary');
  },

  async create(name, spec, ctx) {
    const stackable = spec.stackable === true;
    if (typeof spec.copy_from === 'string') {
      // BW copies view, inputs, mappings and joins from the template.
      const from = spec.copy_from.toUpperCase();
      await bwCreateCompositeProvider(ctx.client, name, { label: String(spec.description), infoArea: String(spec.info_area), package: ctx.package, copyFrom: from });
      return { status: 'created', activation: { lockHandle: await ctx.client.lock('hcpr', name) }, notes: [`copied from HCPR ${from}`] };
    }
    const view = spec.view === 'join' ? 'join' : 'union';
    const inputs = inputsOf(spec.inputs);
    let handle = '';
    if (view === 'union') {
      // A union shell may start empty; each input is then attached with its mappings.
      await bwCreateCompositeProvider(ctx.client, name, { label: String(spec.description), infoArea: String(spec.info_area), viewType: 'Union', package: ctx.package, stackable });
      for (const input of inputs) handle = (await addInput(ctx.client, name, input, ctx.transport)).handle || handle;
    } else {
      // A join shell without inputs is refused by BW (HTTP 500). It is created with both inputs
      // and the join stub; the mappings of each input and the join condition follow.
      await bwCreateCompositeProvider(ctx.client, name, {
        label: String(spec.description),
        infoArea: String(spec.info_area),
        viewType: 'Join',
        package: ctx.package,
        stackable,
        inputs: inputs.map((i) => ({ providerName: i.provider, providerType: i.type })),
      });
      const aliases = parseHcpr(name, await readXml(name)).inputs.map((i) => i.alias);
      if (aliases.length !== 2) throw new ToolError('backend', `${name.toUpperCase()} was created with ${aliases.length} inputs instead of 2.`);
      // BW wants both join fields mapped to one shared target field. The left input keeps its
      // field names; the right input maps its join fields onto the left ones and suffixes the
      // other names that collide (as BWMT does).
      const on = joinPairs(spec.join as JsonObject);
      const left = inputs[0].fields ? { ...inputs[0], fields: [...new Set([...inputs[0].fields, ...on.map((p) => p.left)])] } : inputs[0];
      handle = (await setMappings(ctx.client, name, aliases[0], left, ctx.transport)) || handle;
      const existing = new Set(parseHcpr(name, await readXml(name)).fields.map((f) => f.name));
      const right = await rightJoinMappings(inputs[1], on, existing);
      handle = (await setMappings(ctx.client, name, aliases[1], inputs[1], ctx.transport, right)) || handle;
      handle = (await setJoin(ctx.client, name, aliases[0], aliases[1], spec.join as JsonObject, ctx.transport)) || handle;
    }
    return {
      status: 'created',
      activation: { lockHandle: handle },
      notes: [`${view}, inputs ${inputsOf(spec.inputs).map((i) => i.provider).join(' + ')}`],
    };
  },

  async update(name, spec, ctx) {
    const current = parseHcpr(name, await readXml(name));
    const area = typeof spec.info_area === 'string' ? spec.info_area.toUpperCase() : undefined;
    if (area && area !== current.infoArea) {
      throw new ToolError('not_implemented', `${name.toUpperCase()} is in InfoArea ${current.infoArea}; moving it is not supported yet.`, 'Leave info_area out or give the current one.');
    }
    if (spec.view !== undefined && spec.view !== current.view) {
      throw new ToolError('validation', `${name.toUpperCase()} is a ${current.view}; the view type cannot change.`, 'Create a new CompositeProvider instead.');
    }
    const present = new Set(current.inputs.map((i) => i.provider));
    const notes: string[] = [];
    let handle: string | undefined;
    const done = (json: string, note: string) => {
      const r = JSON.parse(json) as { success?: boolean; message?: string; lock_handle?: string; skipped?: { field: string; reason: string }[] };
      const why = r.skipped?.length ? ` (${r.skipped.map((x) => `${x.field}: ${x.reason}`).join('; ')})` : '';
      if (r.success === false) throw new ToolError('validation', `${note}: ${r.message ?? 'refused by BW'}${why}`, 'bw_read(type="HCPR", detail="full") shows inputs, fields and groups.');
      handle = r.lock_handle ?? handle ?? '';
      notes.push(note);
    };
    const settings: { label?: string; stackable?: boolean; defaultNode?: string } = {};
    if (typeof spec.description === 'string' && spec.description !== current.label) settings.label = spec.description;
    if (typeof spec.stackable === 'boolean' && spec.stackable !== current.stackable) settings.stackable = spec.stackable;
    if (typeof spec.default_node === 'string') {
      const node = current.nodes.find((n) => n.toUpperCase() === String(spec.default_node).toUpperCase());
      if (!node) throw new ToolError('validation', `default_node: ${String(spec.default_node).toUpperCase()} is not a node of HCPR ${name.toUpperCase()}; nodes: ${current.nodes.join(', ') || 'none'}.`);
      if (node !== current.defaultNode) settings.defaultNode = `#///${node}`;
    }
    const label = (k: string) => ({ label: 'description', defaultNode: 'default node' })[k] ?? k;
    if (Object.keys(settings).length > 0) {
      done(await bwUpdateCompositeProviderSettings(ctx.client, name, { ...settings, transport: ctx.transport }), Object.keys(settings).map(label).join(', '));
    }
    for (const input of [...inputsOf(spec.inputs), ...inputsOf(spec.inputs_add)]) {
      if (present.has(input.provider)) continue;
      handle = (await addInput(ctx.client, name, input, ctx.transport)).handle || handle || '';
      notes.push(`added input ${input.provider}`);
    }
    for (const provider of Array.isArray(spec.inputs_remove) ? spec.inputs_remove.map((p) => String(p).toUpperCase()) : []) {
      const input = current.inputs.find((i) => i.provider === provider);
      if (!input) continue;
      const r = JSON.parse(await bwUpdateCompositeProviderInput(ctx.client, name, 'remove_input', { inputAlias: input.alias, transport: ctx.transport })) as { lock_handle?: string };
      handle = r.lock_handle ?? handle ?? '';
      notes.push(`removed input ${provider}`);
    }

    // Further changes work on the state after the inputs changed.
    const changedInputs = handle !== undefined && notes.some((n) => /input/.test(n));
    const now = changedInputs ? parseHcpr(name, await readXml(name)) : current;

    for (const im of Array.isArray(spec.input_mappings) ? (spec.input_mappings as JsonObject[]) : []) {
      const provider = String(im.provider).toUpperCase();
      const input = now.inputs.find((i) => i.provider === provider);
      if (!input) throw new ToolError('validation', `${name.toUpperCase()} has no input ${provider}.`, `Inputs: ${now.inputs.map((i) => i.provider).join(', ') || 'none'}.`);
      const mappings: FieldMapping[] = Array.isArray(im.mappings)
        ? (im.mappings as JsonObject[]).map((m) => ({
            target: String(m.target).toUpperCase(),
            ...(m.source !== undefined ? { source: String(m.source).toUpperCase() } : {}),
            ...(m.constant !== undefined ? { constantValue: String(m.constant) } : {}),
          }))
        : ((im.fields as unknown[] | undefined) ?? []).map((f) => ({ target: String(f).toUpperCase() }));
      const wanted = mappings.map((m) => m.target).sort().join(',');
      if (mappings.length > 0 && wanted === [...input.targets].sort().join(',') && !Array.isArray(im.mappings)) continue;
      done(await bwUpdateCompositeProviderMapping(ctx.client, name, input.alias, mappings, ctx.transport), `mappings of ${provider}`);
    }

    const fieldNames = new Set(now.fields.map((f) => f.name.toUpperCase()));
    const toAdd = (Array.isArray(spec.fields_add) ? spec.fields_add : []).map((f) => String(f).toUpperCase()).filter((f) => !fieldNames.has(f));
    if (toAdd.length > 0) done(await bwUpdateCompositeProvider(ctx.client, name, toAdd.join(','), 'add_field', undefined, ctx.transport), `added ${toAdd.join(', ')}`);
    const toRemove = (Array.isArray(spec.fields_remove) ? spec.fields_remove : []).map((f) => String(f).toUpperCase()).filter((f) => fieldNames.has(f));
    if (toRemove.length > 0) done(await bwUpdateCompositeProvider(ctx.client, name, toRemove.join(','), 'remove_field', undefined, ctx.transport), `removed ${toRemove.join(', ')}`);

    for (const g of Array.isArray(spec.groups) ? (spec.groups as JsonObject[]) : []) {
      done(
        await bwUpdateCompositeProviderGroup(ctx.client, name, String(g.name), {
          ...(typeof g.label === 'string' ? { label: g.label } : {}),
          ...(typeof g.rename_to === 'string' ? { newName: g.rename_to } : {}),
          transport: ctx.transport,
        }),
        `group ${String(g.name).toUpperCase()}`,
      );
    }

    for (const fp of Array.isArray(spec.field_properties) ? (spec.field_properties as JsonObject[]) : []) {
      const field = String(fp.field).toUpperCase();
      const cur = now.fields.find((f) => f.name.toUpperCase() === field);
      const group = typeof fp.group === 'string' ? fp.group.toUpperCase() : undefined;
      const usage = fp.name_usage as 'direct' | 'unique_name' | undefined;
      const aggregation = typeof fp.aggregation === 'string' ? fp.aggregation : undefined;
      if (aggregation && cur && !cur.keyFigure) throw new ToolError('validation', `field_properties ${field}: aggregation applies to key figures only.`);
      if (aggregation && cur?.infoObject) throw new ToolError('validation', `field_properties ${field}: the aggregation of InfoObject ${cur.infoObject} comes from the InfoObject; only fields without InfoObject take their own.`);
      if (
        cur &&
        (group === undefined || cur.group?.toUpperCase() === group) &&
        (usage === undefined || cur.nameUsage === usage) &&
        (aggregation === undefined || (cur.aggregation ?? 'SUM') === aggregation)
      )
        continue;
      done(
        await bwUpdateCompositeProviderFields(ctx.client, name, [field], { ...(group ? { dimension: group } : {}), ...(usage ? { nameUsage: usage } : {}), ...(aggregation ? { aggregation } : {}), transport: ctx.transport }),
        `${field} ${[group && `group ${group}`, usage, aggregation && `aggregation ${aggregation}`].filter(Boolean).join(', ')}`,
      );
    }

    if (spec.join !== undefined) {
      if (now.view !== 'join' || now.inputs.length < 2) throw new ToolError('validation', `${name.toUpperCase()} is not a join of two inputs.`, 'join applies to view=join only.');
      const on = joinPairs(spec.join as JsonObject);
      const type = (spec.join as JsonObject).type === 'left_outer' ? 'leftOuter' : 'inner';
      const j = now.joins.find((x) => x.left === now.inputs[0].alias && x.right === now.inputs[1].alias) ?? now.joins[0];
      const same = j && j.type === type && j.on.map((p) => `${p.left}=${p.right}`).sort().join(',') === on.map((p) => `${p.left}=${p.right}`).sort().join(',');
      if (!same) {
        handle = (await setJoin(ctx.client, name, now.inputs[0].alias, now.inputs[1].alias, spec.join as JsonObject, ctx.transport)) || handle || '';
        notes.push('join condition');
      }
    }

    if (handle === undefined) return { status: 'unchanged' };
    return { status: 'changed', activation: { lockHandle: handle }, notes };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'hcpr', name);
    return { status: 'deleted' };
  },
};
