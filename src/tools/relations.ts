/**
 * bw_context: data flow and where-used of one object in a single answer.
 *
 * relation="dataflow" uses the data flow modeler's transient model (dmod), which follows
 * transformations and DTPs in both directions; relation="where_used" uses the repository's
 * where-used index (xref), which also lists queries, CompositeProviders and other consumers.
 */
import type { JsonObject } from '../catalog/tools.js';
import { TYPE_INFO, isBwType } from '../catalog/types.js';
import { ToolError } from '../format/errors.js';
import { answer, objectRef, statusFields, type ObjectRef, type Structured } from '../format/structured.js';
import { xmlDecode } from '../objects/adapter.js';
import { splitDataSource } from '../objects/flow.js';
import type { BwLike, HandlerContext } from './context.js';
import { parseSearchFeed, type Hit } from './search.js';

const DMOD_ACCEPT = 'application/vnd.sap.bw.modeling.dmod-v1_0_0+xml';
const FEED = 'application/atom+xml;type=feed';

export interface FlowNode {
  id: number;
  type: string;
  name: string;
  sourceSystem?: string;
  /** objectSubType: ATTR or TEXT for the parts of an InfoObject, the element type of an ELEM. */
  subType?: string;
  description: string;
  status: string;
  sources: number[];
  targets: number[];
}

export function parseDataflow(xml: string): FlowNode[] {
  const nodes: FlowNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*)>([\s\S]*?)<\/node>/g)) {
    const [, attrs, body] = m;
    const a = (k: string) => xmlDecode(attrs.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? '');
    const type = a('objectType').toUpperCase();
    const { name, sourceSystem } = splitDataSource(type, a('objectName'));
    nodes.push({
      id: Number(a('nodeID') || 0),
      type,
      name,
      sourceSystem,
      subType: a('objectSubType') || undefined,
      description: a('objectDescription'),
      status: a('objectStatus').toLowerCase(),
      sources: [...body.matchAll(/<sourceNode>#\/\/\/(\d+)<\/sourceNode>/g)].map((x) => Number(x[1])),
      targets: [...body.matchAll(/<targetNode>#\/\/\/(\d+)<\/targetNode>/g)].map((x) => Number(x[1])),
    });
  }
  return nodes;
}

const label = (n: { type: string; name: string; sourceSystem?: string }) => `${n.type} ${n.name}${n.sourceSystem ? ` (${n.sourceSystem})` : ''}`;
const ORDER = ['LSYS', 'RSDS', 'TRCS', 'IOBJ', 'ADSO', 'HCPR', 'ELEM', 'QUERY'];

/** Objects (everything but transformations and DTPs) in the order of the text. */
function flowObjects(nodes: FlowNode[]): FlowNode[] {
  return nodes
    .filter((n) => n.type !== 'TRFN' && n.type !== 'DTPA')
    .sort((a, b) => (ORDER.indexOf(a.type) + 99) % 99 - (ORDER.indexOf(b.type) + 99) % 99 || a.name.localeCompare(b.name));
}

export function formatDataflow(nodes: FlowNode[], header: string): string {
  if (nodes.length === 0) return `${header}\nNo connected objects.`;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ends = (ids: number[]) => ids.map((id) => byId.get(id)).filter((n): n is FlowNode => !!n).map(label).join(', ') || '?';
  const objects = flowObjects(nodes);
  const lines = [header, `Objects (${objects.length}):`];
  const w = Math.max(...objects.map((n) => label(n).length), 10);
  for (const n of objects) lines.push(`  ${label(n).padEnd(w)}  ${n.status.padEnd(8)}  ${n.description}`.trimEnd());
  for (const [type, title] of [['TRFN', 'Transformations'], ['DTPA', 'DTPs']] as const) {
    const list = nodes.filter((n) => n.type === type);
    if (list.length === 0) continue;
    lines.push(`${title} (${list.length}):`);
    for (const n of list) {
      const desc = type === 'DTPA' && n.description ? `  "${n.description}"` : '';
      lines.push(`  ${n.name}  ${ends(n.sources)} → ${ends(n.targets)}${n.status && n.status !== 'active' ? `  (${n.status})` : ''}${desc}`);
    }
  }
  return lines.join('\n');
}

const nodeRef = (n: FlowNode): ObjectRef => objectRef(n.type, n.name, n.sourceSystem, n.subType);

/** cobweb.dataflow/1: the nodes of the data flow model with their edges as references. */
export function dataflowData(nodes: FlowNode[], root: ObjectRef, direction: string, depth: number) {
  const refs = new Map(nodes.map((n) => [n.id, nodeRef(n)]));
  const unresolved: { from: string; node_id: number; side: 'source' | 'target' }[] = [];
  const node = (n: FlowNode) => {
    const r = refs.get(n.id)!;
    const resolve = (ids: number[], side: 'source' | 'target') =>
      ids.flatMap((id) => {
        const to = refs.get(id);
        if (to) return [to.ref];
        unresolved.push({ from: r.ref, node_id: id, side });
        return [];
      });
    return { ...r, ...statusFields(n.status, null), description: n.description, sources: resolve(n.sources, 'source'), targets: resolve(n.targets, 'target') };
  };
  const objects = flowObjects(nodes).map(node);
  const flows = [...nodes.filter((n) => n.type === 'TRFN'), ...nodes.filter((n) => n.type === 'DTPA')].map(node);
  return { root, direction, depth, objects, flows, unresolved };
}

/** "RSDS Z_SFLIGHT SELF ->ADSO ZAISFLIN": which side of a flow title names the object? */
export function sideOf(title: string, name: string): 'up' | 'down' | undefined {
  const parts = title.split('->');
  if (parts.length !== 2) return undefined;
  const has = (s: string) => new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(s.trim());
  if (has(parts[1])) return 'up';
  if (has(parts[0])) return 'down';
  return undefined;
}

const FLOW_END_TYPES = new Set(['ADSO', 'HCPR', 'RSDS', 'TRCS', 'IOBJ', 'IOBJATTR', 'IOBJTEXT', 'IOBJHIER', 'DEST', 'LSYS']);

/** The ends of a transformation or DTP title ("RSDS ZDS SELF -> IOBJTEXT ZCUST"), or null. */
export function titleFlow(title: string): { source: string; source_part: string | null; target: string; target_part: string | null } | null {
  const parts = title.split('->');
  if (parts.length !== 2) return null;
  const end = (s: string): ObjectRef | undefined => {
    const t = s.trim().split(/\s+/);
    const type = (t[0] ?? '').toUpperCase();
    if (!FLOW_END_TYPES.has(type)) return undefined;
    if (type === 'RSDS' ? t.length !== 3 : t.length !== 2) return undefined;
    return objectRef(type, t[1].toUpperCase(), type === 'RSDS' ? t[2] : undefined);
  };
  const source = end(parts[0]);
  const target = end(parts[1]);
  if (!source || !target) return null;
  return { source: source.ref, source_part: source.part ?? null, target: target.ref, target_part: target.part ?? null };
}

/** cobweb.where_used/1. */
export function whereUsedData(hits: Hit[], root: ObjectRef, name: string) {
  return {
    root,
    hits: hits.map((h) => {
      const flowType = h.type === 'TRFN' || h.type === 'DTPA';
      const side = (flowType ? sideOf(h.title, name) : undefined) ?? 'other';
      return {
        ...objectRef(h.type, h.name, h.sourceSystem),
        ...statusFields(h.status),
        description: h.title,
        side,
        flow: flowType && side !== 'other' ? titleFlow(h.title) : null,
      };
    }),
  };
}

export function formatWhereUsed(hits: Hit[], header: string, name: string): string {
  if (hits.length === 0) return `${header}\nNo other object references it.`;
  const groups: Record<'up' | 'down' | 'other', Hit[]> = { up: [], down: [], other: [] };
  for (const h of hits) groups[(h.type === 'TRFN' || h.type === 'DTPA' ? sideOf(h.title, name) : undefined) ?? 'other'].push(h);
  const lines = [header];
  const titles = { up: 'Loading into it (upstream)', down: 'Reading from it (downstream)', other: 'Used by' };
  for (const k of ['up', 'down', 'other'] as const) {
    if (groups[k].length === 0) continue;
    lines.push(`${titles[k]} (${groups[k].length}):`);
    const w = Math.max(...groups[k].map((h) => label(h).length));
    for (const h of groups[k]) lines.push(`  ${label(h).padEnd(w)}  ${h.status.padEnd(8)}  ${h.title}`.trimEnd());
  }
  return lines.join('\n');
}

function objectParam(type: string, name: string, sourceSystem?: string): string {
  if (type !== 'RSDS') return name;
  if (!sourceSystem) throw new ToolError('validation', 'source_system is required for a DataSource (RSDS).', 'bw_search(types=["RSDS"]) shows each DataSource with its source system.');
  return name.padEnd(30) + sourceSystem.toUpperCase();
}

export async function dataflow(client: BwLike, type: string, name: string, sourceSystem: string | undefined, direction: string, depth: number, rootType = type): Promise<Structured> {
  const obj = objectParam(type, name, sourceSystem);
  const params = [`objecttype=${type}`, `objectname=${type === 'RSDS' ? obj.replace(/ /g, '+') : encodeURIComponent(obj)}`];
  if (direction !== 'down') params.push(`levelupwards=${depth}`);
  if (direction !== 'up') params.push(`leveldownwards=${depth}`);
  const { body } = await client.get(`/sap/bw/modeling/dmod/8TRANSIENT?${params.join('&')}`, DMOD_ACCEPT);
  const nodes = parseDataflow(body);
  const dir = direction === 'both' ? 'up and down' : direction;
  const text = formatDataflow(nodes, `Data flow of ${label({ type, name, sourceSystem })} (${dir}, depth ${depth}): ${nodes.length} objects`);
  return answer(text, 'cobweb.dataflow/1', dataflowData(nodes, objectRef(rootType, name, sourceSystem), direction, depth));
}

/** Objects that reference one object, from the repository's where-used index. */
export async function xref(client: BwLike, type: string, name: string, sourceSystem?: string): Promise<Hit[]> {
  const obj = objectParam(type, name, sourceSystem);
  const { body } = await client.get(`/sap/bw/modeling/repo/is/xref?objectType=${encodeURIComponent(type)}&objectName=${encodeURIComponent(obj)}`, FEED);
  return parseSearchFeed(body).filter((h) => !(h.type === type && h.name === name));
}

export async function whereUsed(client: BwLike, type: string, name: string, sourceSystem?: string, rootType = type): Promise<Structured> {
  const hits = await xref(client, type, name, sourceSystem);
  const text = formatWhereUsed(hits, `Where-used of ${label({ type, name, sourceSystem })}: ${hits.length} objects`, name);
  return answer(text, 'cobweb.where_used/1', whereUsedData(hits, objectRef(rootType, name, sourceSystem), name));
}

export async function bwContext(args: JsonObject, ctx: HandlerContext): Promise<Structured> {
  const requested = String(args.type).toUpperCase();
  // Queries and other query elements are ELEM in the repository services.
  const type = isBwType(requested) ? TYPE_INFO[requested].searchType ?? requested : requested;
  const name = String(args.name).trim().toUpperCase();
  const sourceSystem = typeof args.source_system === 'string' ? args.source_system.toUpperCase() : undefined;
  const rootType = isBwType(requested) ? requested : type;
  if (args.relation === 'where_used') return whereUsed(ctx.client(), type, name, sourceSystem, rootType);
  return dataflow(ctx.client(), type, name, sourceSystem, String(args.direction ?? 'both'), Number(args.depth ?? 1), rootType);
}
