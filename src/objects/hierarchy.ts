/**
 * Hierarchies of a characteristic (type HIER, name "<characteristic>/<hierarchy>").
 *
 * The content lives in the BW/4HANA data API, not in the modeling API; src/legacy/hierarchy.ts
 * holds those paths. This adapter adds the coBWeb side: a compact tree in the words the spec
 * uses, a declarative tree (the same spec again reports unchanged), and add/remove of subtrees
 * so a large hierarchy need not be sent whole for a small change.
 */
import type { BwClient } from '../bw/client.js';
import type { BwType } from '../catalog/types.js';
import { ToolError, legacyRefusal } from '../format/errors.js';
import {
  bwCreateHierarchy,
  bwDeleteHierarchy,
  bwUpdateHierarchy,
  buildChangeLog,
  buildTree,
  listHierarchies,
  TEXT_NODE,
  type HierarchyHeader,
  type HierarchyNodeInput,
  type HierarchyNodeRow,
} from '../legacy/hierarchy.js';
import type { ObjectAdapter, ObjectRef, ReadOptions, Spec, WriteAction } from './adapter.js';

type Rec = Record<string, unknown>;
const BASE = '/sap/bc/http/sap/bw4/v1';
const JSON_HEADERS = { Accept: '*/*', 'Content-Type': 'application/json' };

/** "ZREGION/ZWORLD" → characteristic and hierarchy name. */
export function splitName(name: string): { cha: string; hier: string } {
  const i = name.indexOf('/');
  if (i <= 0 || i === name.length - 1) {
    throw new ToolError('validation', `Hierarchy name "${name}" must be "<characteristic>/<hierarchy>", e.g. "ZREGION/ZWORLD"`);
  }
  return { cha: name.slice(0, i).toUpperCase(), hier: name.slice(i + 1).toUpperCase() };
}

async function header(client: BwClient, cha: string, hier: string, prefer: 'A' | 'M' = 'A'): Promise<HierarchyHeader | undefined> {
  const all = (await listHierarchies(client, cha)).filter((h) => h.hienm.toUpperCase() === hier);
  return all.find((h) => h.objvers === prefer) ?? all[0];
}

async function rowsOf(client: BwClient, h: HierarchyHeader): Promise<HierarchyNodeRow[]> {
  const { body } = await client.rawGet(`${BASE}/data/hierarchies/${encodeURIComponent(h.hieid)}/versions/${h.objvers}/content?depth=99`, JSON_HEADERS);
  return (body.trim() ? (JSON.parse(body) as HierarchyNodeRow[]) : []) ?? [];
}

const titleOf = (h: HierarchyHeader & { txtmd?: string }) => h.txtlg || h.txtmd || h.txtsh || '';
const realDate = (d: string | undefined) => (!d || /^0{4}-0{2}-0{2}$/.test(d) ? '' : d);

// ── Tree in spec form ─────────────────────────────────────────────────────────

/**
 * The current tree as spec nodes. Nodes the spec cannot express (links, intervals, nodes of
 * another characteristic) are reported, so a write never drops them silently.
 */
export function treeOf(rows: HierarchyNodeRow[], cha: string): { nodes: HierarchyNodeInput[]; foreign: string[] } {
  const { roots, children } = buildTree(rows);
  const foreign: string[] = [];
  const conv = (list: HierarchyNodeRow[]): HierarchyNodeInput[] =>
    list.map((r) => {
      const kids = conv(children.get(String(Number(r.NODEID))) ?? []);
      if (r.LINK || (r.INTERVL && r.INTERVL !== '' && r.INTERVL !== ' ') || (r.IOBJNM !== TEXT_NODE && r.IOBJNM !== cha)) {
        foreign.push(`${r.NODENAME} (${r.LINK ? 'link' : r.IOBJNM !== TEXT_NODE && r.IOBJNM !== cha ? r.IOBJNM : 'interval'})`);
      }
      const base: HierarchyNodeInput =
        r.IOBJNM === TEXT_NODE ? { text_node: r.NODENAME, ...(r.NODEDESCRIPTION && r.NODEDESCRIPTION !== r.NODENAME ? { text: r.NODEDESCRIPTION } : {}) } : { value: r.NODENAME };
      return kids.length ? { ...base, children: kids } : base;
    });
  return { nodes: conv(roots), foreign };
}

/** A spec node in its full form: bare strings are value nodes, names upper case for text nodes. */
export function normalize(nodes: unknown, path = 'nodes'): HierarchyNodeInput[] {
  if (!Array.isArray(nodes)) throw new ToolError('validation', `${path} must be an array of nodes.`);
  return nodes.map((n, i) => {
    const at = `${path}[${i}]`;
    if (typeof n === 'string') return { value: n };
    if (!n || typeof n !== 'object') throw new ToolError('validation', `${at} must be a value (string) or {text_node, text, children} / {value, children}.`);
    const r = n as Rec;
    const unknown = Object.keys(r).filter((k) => !['text_node', 'text', 'value', 'children'].includes(k));
    if (unknown.length) throw new ToolError('validation', `${at}: unknown ${unknown.join(', ')} (allowed: text_node, text, value, children).`);
    const isText = typeof r['text_node'] === 'string';
    if (isText === (typeof r['value'] === 'string')) throw new ToolError('validation', `${at} needs exactly one of text_node or value.`);
    if (!isText && r['text'] !== undefined) throw new ToolError('validation', `${at}: a value node takes its text from the master data; text is only for text nodes.`);
    const out: HierarchyNodeInput = isText
      ? { text_node: String(r['text_node']).trim().toUpperCase(), ...(typeof r['text'] === 'string' && r['text'] ? { text: r['text'] } : {}) }
      : { value: String(r['value']).trim() };
    if (r['children'] !== undefined) {
      const kids = normalize(r['children'], `${at}.children`);
      if (kids.length) out.children = kids;
    }
    return out;
  });
}

const nodeKey = (n: HierarchyNodeInput) => (n.text_node !== undefined ? `T:${n.text_node.toUpperCase()}` : `V:${String(n.value).toUpperCase()}`);
const nodeName = (n: HierarchyNodeInput) => (n.text_node !== undefined ? n.text_node : String(n.value));

/** Comparable form: text of a text node defaults to its name, as BW stores it. */
function canon(nodes: HierarchyNodeInput[]): unknown {
  return nodes.map((n) => [nodeKey(n), n.text_node !== undefined ? ((n.text ?? n.text_node) === n.text_node ? '' : n.text) : '', canon(n.children ?? [])]);
}

export const sameTree = (a: HierarchyNodeInput[], b: HierarchyNodeInput[]) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * remove: names of nodes to cut with their subtree; add: [{under, nodes}] appends nodes below
 * a node (under omitted or null: at the top level). Names match text nodes first, then values.
 */
export function applyChanges(current: HierarchyNodeInput[], remove: string[], add: Array<{ under?: string | null; nodes: HierarchyNodeInput[] }>): HierarchyNodeInput[] {
  const copy = (list: HierarchyNodeInput[]): HierarchyNodeInput[] => list.map((n) => ({ ...n, ...(n.children ? { children: copy(n.children) } : {}) }));
  let tree = copy(current);
  const find = (name: string, list: HierarchyNodeInput[]): HierarchyNodeInput | undefined => {
    const up = name.toUpperCase();
    const walk = (l: HierarchyNodeInput[], kind: 'T' | 'V'): HierarchyNodeInput | undefined => {
      for (const n of l) {
        if (nodeKey(n) === `${kind}:${up}`) return n;
        const hit = walk(n.children ?? [], kind);
        if (hit) return hit;
      }
      return undefined;
    };
    return walk(list, 'T') ?? walk(list, 'V');
  };
  for (const name of remove) {
    const target = find(name, tree);
    if (!target) throw new ToolError('validation', `remove: the hierarchy has no node ${name}.`);
    const cut = (l: HierarchyNodeInput[]): HierarchyNodeInput[] =>
      l.filter((n) => n !== target).map((n) => (n.children ? { ...n, children: cut(n.children) } : n));
    tree = cut(tree);
  }
  for (const a of add) {
    if (a.under === undefined || a.under === null || a.under === '') {
      tree.push(...a.nodes);
      continue;
    }
    const parent = find(a.under, tree);
    if (!parent) throw new ToolError('validation', `add: the hierarchy has no node ${a.under}.`);
    if (parent.text_node === undefined) throw new ToolError('validation', `add: ${a.under} is a value node; nodes go below text nodes.`);
    parent.children = [...(parent.children ?? []), ...a.nodes];
  }
  return tree;
}

function treeLines(rows: HierarchyNodeRow[], cha: string, full: boolean): string[] {
  const { roots, children } = buildTree(rows);
  const out: string[] = [];
  const walk = (list: HierarchyNodeRow[], depth: number) => {
    for (const r of list) {
      const isText = r.IOBJNM === TEXT_NODE;
      const text = r.NODEDESCRIPTION && r.NODEDESCRIPTION !== r.NODENAME ? r.NODEDESCRIPTION : '';
      const what = isText ? `${r.NODENAME}${text ? ` "${text}"` : ''}` : `${r.NODENAME}${text ? ` · ${text}` : ''}`;
      const extra = [r.LINK ? 'link' : '', !isText && r.IOBJNM !== cha ? r.IOBJNM : '', full ? `id ${Number(r.NODEID)}` : ''].filter(Boolean);
      out.push(`${'  '.repeat(depth + 1)}${what}${extra.length ? `  [${extra.join(', ')}]` : ''}`);
      walk(children.get(String(Number(r.NODEID))) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const DESCRIBE_CREATE = [
  'HIER create spec (hierarchy of a characteristic; name "<characteristic>/<hierarchy>")',
  '  description   text, max 60                                            (required)',
  '  nodes         the tree (required): [{text_node: NAME, text, children: [...]}',
  '                | {value: VALUE, children} | "VALUE"]; a bare string is a value node.',
  '                Text nodes group; values are characteristic values with master data.',
  '                Every node may appear once.',
  'Saved and activated in the same call. BW/4HANA only.',
  'Example',
  '  {"action":"create","type":"HIER","name":"ZREGION/ZWORLD","spec":{"description":"World","nodes":[{"text_node":"EUROPE","text":"Europe","children":["DE","FR"]},"US"]}}',
].join('\n');

const DESCRIBE_UPDATE = [
  'HIER update spec — only the named parts change',
  '  description   text, max 60',
  '  nodes         the complete new tree (as in create); the same tree again is unchanged',
  '  remove        [node names]: cut these nodes with everything below them',
  '  add           [{under: NODE | null, nodes: [...]}]: append below a text node, or at the top',
  'nodes or remove/add, not both; remove runs before add. The hierarchy keeps its id, so',
  'queries that use it keep working. Activated in the same call.',
].join('\n');

export const hierAdapter: ObjectAdapter = {
  type: 'HIER' as BwType,
  label: 'Hierarchy',
  async locate(client, name) {
    const { cha, hier } = splitName(name);
    let h: HierarchyHeader | undefined;
    try {
      h = await header(client, cha, hier);
    } catch (err) {
      if (/HTTP 404\b/.test((err as Error).message)) return { exists: false };
      throw err;
    }
    return h ? { exists: true, active: h.objvers === 'A' } : { exists: false };
  },
  async read(client, name, { detail, part }: ReadOptions) {
    const { cha, hier } = splitName(name);
    // part="revised": the revised version, where a change waits that is not active yet.
    const h = await header(client, cha, hier, part?.toLowerCase() === 'revised' ? 'M' : 'A');
    if (!h) throw new ToolError('not_found', `HIER ${cha}/${hier} not found.`, `bw_read(type="IOBJ", name="${cha}", part="hierarchies") lists the hierarchies of ${cha}.`);
    const rows = await rowsOf(client, h);
    if (detail === 'raw') return JSON.stringify({ header: h, nodes: rows }, null, 2);
    const levels = Number(h.numberlevel ?? 0) || Math.max(0, ...rows.map((r) => Number(r.TLEVEL)));
    const validity = realDate(h.datefrom) || (h.dateto && h.dateto !== '9999-12-31') ? ` · valid ${realDate(h.datefrom) || '…'} – ${h.dateto}` : '';
    const head = `HIER ${cha}/${h.hienm} "${titleOf(h)}" · ${h.objvers === 'A' ? 'active' : 'revised, not active'}${h.version ? ` · version ${h.version}` : ''}${validity} · ${rows.length} node${rows.length === 1 ? '' : 's'}, ${levels} level${levels === 1 ? '' : 's'}`;
    const full = detail === 'full';
    return [
      head,
      ...(full ? [`Hierarchy id: ${h.hieid}`] : []),
      'Tree (text nodes NAME "text", values VALUE · text):',
      ...treeLines(rows, cha, full),
    ].join('\n');
  },
  describe: (action) => (action === 'create' ? DESCRIBE_CREATE : DESCRIBE_UPDATE),
  check(action: WriteAction, name, spec) {
    const errors: string[] = [];
    try {
      splitName(name);
    } catch (err) {
      errors.push((err as Error).message);
      return errors;
    }
    if (action === 'delete') return errors;
    const s = (spec ?? {}) as Rec;
    const allowed = action === 'create' ? ['description', 'nodes'] : ['description', 'nodes', 'add', 'remove'];
    const unknown = Object.keys(s).filter((k) => !allowed.includes(k));
    if (unknown.length) errors.push(`unknown ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
    if (s['description'] !== undefined && (typeof s['description'] !== 'string' || !s['description'] || s['description'].length > 60)) errors.push('description must be a text of 1 to 60 characters');
    if (action === 'create') {
      if (typeof s['description'] !== 'string') errors.push('description is required');
      if (!Array.isArray(s['nodes']) || !s['nodes'].length) errors.push('nodes is required (at least one node)');
    } else {
      if (s['nodes'] !== undefined && (s['add'] !== undefined || s['remove'] !== undefined)) errors.push('give nodes (the complete tree) or add/remove, not both');
      if (s['nodes'] !== undefined && (!Array.isArray(s['nodes']) || !s['nodes'].length)) errors.push('nodes must be the complete new tree (at least one node)');
      if (s['remove'] !== undefined && (!Array.isArray(s['remove']) || s['remove'].some((x) => typeof x !== 'string'))) errors.push('remove must be a list of node names');
      if (s['add'] !== undefined) {
        if (!Array.isArray(s['add'])) errors.push('add must be a list of {under, nodes}');
        else
          (s['add'] as unknown[]).forEach((a, i) => {
            const r = (a ?? {}) as Rec;
            const extra = Object.keys(r).filter((k) => k !== 'under' && k !== 'nodes');
            if (extra.length) errors.push(`add[${i}]: unknown ${extra.join(', ')} (allowed: under, nodes)`);
            if (!Array.isArray(r['nodes']) || !r['nodes'].length) errors.push(`add[${i}].nodes needs at least one node`);
          });
      }
      if (Object.keys(s).length === 0) errors.push('nothing to change: give description, nodes, add or remove');
    }
    const trees: unknown[] = [s['nodes'], ...(Array.isArray(s['add']) ? (s['add'] as Rec[]).map((a) => a?.['nodes']) : [])].filter((t) => t !== undefined);
    for (const t of trees) {
      try {
        buildChangeLog('CHECK', 'CHECK', normalize(t));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    return errors;
  },
  dependsOn(action, name): ObjectRef[] {
    if (action === 'delete') return [];
    try {
      return [{ type: 'IOBJ', name: splitName(name).cha }];
    } catch {
      return [];
    }
  },
  targetInfoArea: () => undefined,
  boundary: () => [],
  async create(name, spec, ctx) {
    const { cha, hier } = splitName(name);
    const s = spec as Rec;
    const nodes = normalize(s['nodes']);
    const answer = JSON.parse(await bwCreateHierarchy(ctx.client, { characteristic: cha, hierarchy_name: hier, description: String(s['description']), nodes })) as Rec;
    if (answer['success'] !== true) {
      throw new ToolError('activation_failed', `Hierarchy ${cha}/${hier} was saved but not activated: ${legacyRefusal(answer)}`, `It exists as a revised version; fix it with an update or delete it.`);
    }
    return { status: 'created', activated: true, notes: [`${answer['node_count']} node${answer['node_count'] === 1 ? '' : 's'}`] };
  },
  async update(name, spec, ctx) {
    const { cha, hier } = splitName(name);
    const s = spec as Rec;
    const h = await header(ctx.client, cha, hier);
    if (!h) throw new ToolError('not_found', `HIER ${cha}/${hier} not found.`);
    const notes: string[] = [];
    let description: string | undefined;
    if (typeof s['description'] === 'string' && s['description'] !== titleOf(h)) description = s['description'];
    let nodes: HierarchyNodeInput[] | undefined;
    if (s['nodes'] !== undefined || s['add'] !== undefined || s['remove'] !== undefined) {
      const { nodes: current, foreign } = treeOf(await rowsOf(ctx.client, h), cha);
      if (foreign.length) {
        throw new ToolError('validation', `The tree of ${cha}/${hier} has nodes a spec cannot express: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}. Change it in the hierarchy maintenance instead.`);
      }
      const wanted =
        s['nodes'] !== undefined
          ? normalize(s['nodes'])
          : applyChanges(
              current,
              ((s['remove'] as string[] | undefined) ?? []),
              ((s['add'] as Rec[] | undefined) ?? []).map((a, i) => ({ under: (a['under'] as string | null | undefined) ?? null, nodes: normalize(a['nodes'], `add[${i}].nodes`) })),
            );
      if (!wanted.length) throw new ToolError('validation', 'The change leaves an empty tree; delete the hierarchy instead.');
      buildChangeLog('CHECK', cha, wanted);
      if (!sameTree(current, wanted)) {
        nodes = wanted;
        const count = (l: HierarchyNodeInput[]): number => l.reduce((n, x) => n + 1 + count(x.children ?? []), 0);
        notes.push(`tree ${count(current)} → ${count(wanted)} nodes`);
      }
    }
    if (description === undefined && nodes === undefined) return { status: 'unchanged' };
    if (description !== undefined) notes.unshift('description');
    const answer = JSON.parse(await bwUpdateHierarchy(ctx.client, { characteristic: cha, hierarchy_name: hier, ...(description !== undefined ? { description } : {}), ...(nodes ? { nodes } : {}) })) as Rec;
    if (answer['success'] !== true) {
      throw new ToolError('activation_failed', `Hierarchy ${cha}/${hier} was saved but not activated: ${legacyRefusal(answer)}`, 'The change waits in the revised version.');
    }
    return { status: 'changed', activated: true, notes };
  },
  async delete(name, ctx) {
    const { cha, hier } = splitName(name);
    await bwDeleteHierarchy(ctx.client, { characteristic: cha, hierarchy_name: hier });
    return { status: 'deleted' };
  },
};

/** part="hierarchies" of a characteristic. */
export async function hierarchyList(client: BwClient, cha: string): Promise<string> {
  let list: HierarchyHeader[];
  try {
    list = await listHierarchies(client, cha);
  } catch (err) {
    if (/HTTP 404\b/.test((err as Error).message)) return `${cha.toUpperCase()} has no hierarchies (or the BW/4HANA data API is not available).`;
    throw err;
  }
  if (!list.length) return `${cha.toUpperCase()} has no hierarchies.`;
  return [
    `Hierarchies (${list.length}), read with bw_read(type="HIER", name="${cha.toUpperCase()}/<name>"):`,
    ...list.map((h) => {
      const validity = realDate(h.datefrom) || (h.dateto && h.dateto !== '9999-12-31') ? ` · valid ${realDate(h.datefrom) || '…'} – ${h.dateto}` : '';
      return `  ${h.hienm}  "${titleOf(h)}" · ${h.objvers === 'A' ? 'active' : 'revised'}${h.version ? ` · version ${h.version}` : ''}${validity}${Number(h.numberlevel ?? 0) ? ` · ${Number(h.numberlevel)} levels` : ''}`;
    }),
  ].join('\n');
}
