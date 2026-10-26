/**
 * Roles (type ROLE, read only): the roles a query can be published in, with their folders and
 * the queries published there. A name with * lists the matching roles.
 *
 * Publishing is part of the query spec (roles_add / roles_remove); the roles of one query are
 * bw_read(type="QUERY", part="roles").
 */
import type { BwClient } from '../bw/client.js';
import type { BwType } from '../catalog/types.js';
import { ToolError } from '../format/errors.js';
import { fetchQueryAssignments, fetchRolesTree, type RoleNode } from '../legacy/roles.js';
import { xmlDecode, type ObjectReader, type ReadOptions } from './adapter.js';

const ROLES_WITH_LEAVES = '/sap/bw/modeling/comp/roles?level=10&requestchk=true&readleaves=true';

function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], xmlDecode(m[2])]));
}

export interface RoleContent {
  name: string;
  text: string;
  /** Published objects with the folder path they sit in ('' at role level). */
  items: Array<{ name: string; text: string; type: string; provider: string; folder: string }>;
  folders: string[];
}

/** Roles with their folders and published objects, from the tree read with its leaves. */
export function parseRoleTree(xml: string): RoleContent[] {
  const roles: RoleContent[] = [];
  const stack: Array<{ type: string; name: string; text: string; role?: RoleContent }> = [];
  const current = () => [...stack].reverse().find((s) => s.role)?.role;
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>|<leaf\b([^>]*?)\/?>/g)) {
    if (m[0].startsWith('</node')) {
      stack.pop();
      continue;
    }
    if (m[0].startsWith('<leaf')) {
      const a = attrs(m[3] ?? '');
      const role = current();
      if (!role) continue;
      const path = stack.slice(stack.findIndex((s) => s.role === role) + 1).map((s) => s.text);
      role.items.push({ name: a['name'] ?? '', text: a['txt'] ?? '', type: [a['objectType'], a['objectSubType']].filter(Boolean).join('/'), provider: a['infoprov'] ?? '', folder: path.join(' / ') });
      continue;
    }
    const a = attrs(m[1] ?? '');
    const entry: { type: string; name: string; text: string; role?: RoleContent } = { type: a['type'] ?? 'FOLDER', name: a['name'] ?? '', text: a['txt'] ?? '' };
    const role = current();
    if (entry.type === 'ROLE') {
      entry.role = { name: entry.name, text: entry.text, items: [], folders: [] };
      roles.push(entry.role);
    } else if (role) {
      const path = [...stack.slice(stack.findIndex((s) => s.role === role) + 1).map((s) => s.text), entry.text];
      role.folders.push(path.join(' / '));
    }
    if (m[2] !== '/') stack.push(entry);
  }
  return roles;
}

function roleList(tree: RoleNode[]): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const walk = (nodes: RoleNode[]) => {
    for (const n of nodes) {
      if (n.type === 'ROLE') out.push({ name: n.name, text: n.txt });
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

function findRole(tree: RoleNode[], name: string): RoleNode | undefined {
  for (const n of tree) {
    if (n.type === 'ROLE' && n.name.toUpperCase() === name.toUpperCase()) return n;
    const hit = findRole(n.children, name);
    if (hit) return hit;
  }
  return undefined;
}

function folderPaths(nodes: RoleNode[], prefix = ''): string[] {
  return nodes.filter((n) => n.type === 'FOLDER').flatMap((n) => {
    const path = prefix ? `${prefix} / ${n.txt}` : n.txt;
    return [path, ...folderPaths(n.children, path)];
  });
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

export function summarizeRole(r: RoleContent): string {
  const queries = r.items.filter((i) => /QUERY|^ELEM\/REP$/i.test(i.type) || i.type === '');
  const lines = [`ROLE ${r.name} "${r.text}" · ${r.items.length} published object${r.items.length === 1 ? '' : 's'}${r.folders.length ? ` · folders: ${r.folders.join(', ')}` : ''}`];
  const byFolder = new Map<string, typeof r.items>();
  for (const i of r.items) byFolder.set(i.folder, [...(byFolder.get(i.folder) ?? []), i]);
  for (const [folder, items] of byFolder) {
    if (folder) lines.push(`Folder "${folder}":`);
    for (const i of items) lines.push(`  ${i.name}${i.text && i.text !== i.name ? ` "${i.text}"` : ''}${i.provider ? ` · on ${i.provider}` : ''}${queries.includes(i) ? '' : ` · ${i.type}`}`);
  }
  if (!r.items.length) lines.push('Nothing published.');
  return lines.join('\n');
}

export const roleReader: ObjectReader = {
  type: 'ROLE' as BwType,
  label: 'Role',
  async locate(client, name) {
    if (name.includes('*')) return { exists: true };
    const found = roleList(await fetchRolesTree(client)).some((r) => r.name.toUpperCase() === name.toUpperCase());
    return { exists: found };
  },
  async read(client, name, { detail }: ReadOptions) {
    if (name.includes('*') || !name.trim()) {
      const all = roleList(await fetchRolesTree(client));
      const re = glob(name.trim() || '*');
      const hits = all.filter((r) => re.test(r.name));
      if (!hits.length) return `No role matches ${name} (${all.length} roles in all).`;
      const w = Math.max(...hits.map((r) => r.name.length));
      return [`Roles matching ${name} (${hits.length} of ${all.length}); read one for its folders and queries:`, ...hits.map((r) => `  ${r.name.padEnd(w)}  ${r.text}`)].join('\n');
    }
    const { body } = await client.rawGet(ROLES_WITH_LEAVES, { Accept: 'application/xml', 'X-sap-adt-sessiontype': 'stateless' });
    if (detail === 'raw') return body;
    // The tree read with its leaves holds only the branches where something is published.
    const role = parseRoleTree(body).find((r) => r.name.toUpperCase() === name.toUpperCase());
    if (role) return summarizeRole(role);
    const node = findRole(await fetchRolesTree(client), name);
    if (!node) throw new ToolError('not_found', `ROLE ${name.toUpperCase()} not found.`, 'bw_read(type="ROLE", name="*") lists the roles.');
    return summarizeRole({ name: node.name, text: node.txt, items: [], folders: folderPaths(node.children) });
  },
};

/** part="roles" of a query: where it is published. */
export async function queryRoles(client: BwClient, query: string): Promise<string> {
  const { assignments } = await fetchQueryAssignments(client, query.toUpperCase());
  if (!assignments.length) return 'Roles: not published in any role.';
  return [`Roles (${assignments.length}):`, ...assignments.map((a) => `  ${a.roleName}${a.folder ? ` / folder "${a.folder.txt}"` : ''}${a.roleTxt ? `  ${a.roleTxt}` : ''}`)].join('\n');
}
