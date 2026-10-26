// Atom feed parsing based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE). Tool logic and output format are new in coBWeb.
/**
 * bw_search: find BW objects by name or description, or list one level of an InfoArea.
 *
 * Search:   GET /sap/bw/modeling/repo/is/bwsearch (Atom feed)
 * InfoArea: GET /sap/bw/modeling/repo/infoproviderstructure/area/<name> (type folders),
 *           then each folder's children.
 */
import { TYPE_INFO, isBwType, typeFromSearch, type BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError } from '../format/errors.js';
import type { BwLike, HandlerContext } from './context.js';

export interface Hit {
  type: string;
  name: string;
  /** DataSources only: the source system, which BW appends to the name. */
  sourceSystem?: string;
  status: string;
  title: string;
  href: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Entries of a BW search or xref Atom feed. */
export function parseSearchFeed(xml: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of xml.matchAll(/<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g)) {
    const body = m[1];
    const name = body.match(/objectName="([^"]+)"/)?.[1];
    const type = body.match(/objectType="([^"]+)"/)?.[1];
    if (!name || !type) continue;
    const subtype = body.match(/objectSubtype="([^"]*)"/)?.[1] || undefined;
    hits.push({
      ...splitName(typeFromSearch(type, subtype), decodeEntities(name)),
      status: (body.match(/objectStatus="([^"]+)"/)?.[1] ?? 'unknown').toLowerCase(),
      title: decodeEntities(body.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? ''),
      href: body.match(/href="([^"]+)"/)?.[1] ?? '',
    });
  }
  return hits;
}

/**
 * A DataSource is named "<datasource padded to 30> <source system>" in the search feed
 * (e.g. "ZDS_SALES                     SELF_CDS"). Split it so the name is usable as is.
 */
function splitName(type: string, raw: string): { type: string; name: string; sourceSystem?: string } {
  const m = type === 'RSDS' ? raw.match(/^(\S+)\s+(\S+)$/) : null;
  return m ? { type, name: m[1], sourceSystem: m[2] } : { type, name: raw.trim() };
}

export interface RepoEntry extends Hit {
  childrenPath: string | null;
}

const REPO_BASE = '/sap/bw/modeling/repo/infoproviderstructure';

/** Entries of a repository tree feed (infoproviderstructure). */
export function parseRepoFeed(xml: string): RepoEntry[] {
  const entries: RepoEntry[] = [];
  for (const m of xml.matchAll(/<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g)) {
    const body = m[1];
    const attrs = body.match(/<bwModel:object\b([\s\S]*?)(?:\/>|>)/)?.[1] ?? '';
    const type = attrs.match(/\bobjectType="([^"]*)"/)?.[1] ?? '';
    const subtype = attrs.match(/\bobjectSubtype="([^"]*)"/)?.[1] || undefined;
    let childrenHref: string | null = null;
    let selfHref = '';
    for (const l of body.matchAll(/<atom:link\b([\s\S]*?)(?:\/>|>)/g)) {
      const rel = l[1].match(/\brel="([^"]*)"/)?.[1] ?? '';
      const href = l[1].match(/\bhref="([^"]*)"/)?.[1] ?? '';
      if (rel === 'self') selfHref = href;
      else if (rel === 'http://www.sap.com/bw/modeling/relations:children') childrenHref = href || null;
    }
    entries.push({
      ...splitName(type ? typeFromSearch(type, subtype) : '', decodeEntities(attrs.match(/\bobjectName="([^"]*)"/)?.[1] ?? '')),
      status: (attrs.match(/\bobjectStatus="([^"]*)"/)?.[1] ?? '').toLowerCase(),
      title: decodeEntities(body.match(/<atom:title[^>]*>([^<]*)<\/atom:title>/)?.[1] ?? ''),
      href: selfHref,
      childrenPath: childrenHref
        ? childrenHref.startsWith(`${REPO_BASE}/`)
          ? childrenHref.slice(REPO_BASE.length + 1)
          : childrenHref
        : null,
    });
  }
  return entries;
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function searchPath(term: string, searchType: string): string {
  const from = '1970-01-01T00%3A00%3A00Z';
  const to = '2099-12-31T23%3A59%3A59Z';
  return (
    '/sap/bw/modeling/repo/is/bwsearch' +
    `?searchTerm=${encodeURIComponent(term)}&searchInName=true&searchInDescription=true` +
    `&objectType=${encodeURIComponent(searchType)}` +
    `&createdOnFrom=${from}&createdOnTo=${to}&changedOnFrom=${from}&changedOnTo=${to}`
  );
}

const FEED = 'application/atom+xml;type=feed';

/**
 * The search service rejects type filters it does not know on a release with a short dump
 * (HTTP 500) rather than an empty feed. Then the search runs once
 * without the filter and the hits are filtered here.
 */
async function searchService(client: BwLike, term: string, types: BwType[], notes: string[]): Promise<Hit[]> {
  const searchTypes = [...new Set(types.map((t) => TYPE_INFO[t].searchType))];
  if (searchTypes.length === 1) {
    try {
      return parseSearchFeed((await client.get(searchPath(term, searchTypes[0]), FEED)).body);
    } catch (err) {
      if (!/HTTP (400|500)\b/.test(err instanceof Error ? err.message : String(err))) throw err;
      notes.push(`The search service of this system does not accept the type filter ${searchTypes[0]}; the results come from an unfiltered search.`);
    }
  }
  return parseSearchFeed((await client.get(searchPath(term, ''), FEED)).body);
}

async function listInfoArea(client: BwLike, area: string): Promise<Hit[]> {
  let top: RepoEntry[];
  try {
    top = parseRepoFeed((await client.get(`${REPO_BASE}/area/${encodeURIComponent(area.toLowerCase())}`, 'application/atom+xml')).body);
  } catch (err) {
    if (/HTTP 404\b/.test(err instanceof Error ? err.message : String(err))) {
      throw new ToolError('not_found', `InfoArea ${area} not found.`, 'Find InfoAreas with bw_search(query=..., types=["AREA"]).');
    }
    throw err;
  }
  // An InfoArea lists its objects in type folders (objectType "semanticalFolder", named after
  // the type, e.g. ADSO, IOBJ_CHA, IOBJ_KYF) plus its sub-InfoAreas directly.
  const isFolder = (e: RepoEntry) => Boolean(e.childrenPath) && (e.type === 'SEMANTICALFOLDER' || !e.name);
  if (top.length === 0) {
    // BW answers an unknown InfoArea with an empty feed, not with 404; tell the two apart.
    const exists = (await searchService(client, area, ['AREA'], [])).some((h) => h.type === 'AREA' && h.name.toUpperCase() === area.toUpperCase());
    if (!exists) {
      throw new ToolError('not_found', `InfoArea ${area} not found.`, 'Find InfoAreas with bw_search(query=..., types=["AREA"]).');
    }
  }
  const objects: Hit[] = top.filter((e) => e.name && !isFolder(e));
  const folders = top.filter(isFolder);
  // Folders are few (one per object type present); read them in small parallel batches.
  for (let i = 0; i < folders.length; i += 4) {
    const batch = await Promise.all(
      folders.slice(i, i + 4).map(async (f) => parseRepoFeed((await client.get(`${REPO_BASE}/${f.childrenPath}`, 'application/atom+xml')).body)),
    );
    for (const entries of batch) objects.push(...entries.filter((e) => e.name && !isFolder(e)));
  }
  return objects;
}

function keepType(hit: Hit, types: BwType[]): boolean {
  if (types.length === 0) return true;
  if ((types as string[]).includes(hit.type)) return true;
  // An ELEM entry without a subtype cannot be told apart; keep it when any component type is asked for.
  return hit.type === 'ELEM' && types.some((t) => TYPE_INFO[t].searchType === 'ELEM');
}

export function formatHits(hits: Hit[], header: string, limit: number, notes: string[] = []): string {
  const shown = hits.slice(0, limit);
  const lines = [hits.length === 0 ? `${header}: no objects found.` : `${header}: ${hits.length} hit${hits.length === 1 ? '' : 's'}${hits.length > limit ? `, showing ${limit}` : ''}`];
  lines.push(...notes);
  if (shown.length > 0) {
    const w = Math.max(...shown.map((h) => h.type.length));
    const label = (h: Hit) => (h.sourceSystem ? `${h.name} (${h.sourceSystem})` : h.name);
    const n = Math.max(...shown.map((h) => label(h).length));
    for (const h of shown) {
      lines.push(`${h.type.padEnd(w)}  ${label(h).padEnd(n)}  ${(h.status || '-').padEnd(8)}  ${h.title}`.trimEnd());
    }
  }
  if (hits.length > limit) lines.push(`… ${hits.length - limit} more. Narrow with types or a more specific query, or raise limit.`);
  return lines.join('\n');
}

export async function bwSearch(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const infoArea = typeof args.info_area === 'string' ? args.info_area.trim().toUpperCase() : '';
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const sourceSystem = typeof args.source_system === 'string' ? args.source_system.trim().toUpperCase() : '';
  const types = ((args.types as string[] | undefined) ?? []).map((t) => t.toUpperCase()).filter(isBwType);
  if (!query && !infoArea) {
    throw new ToolError('validation', 'Pass query (name or text pattern) or info_area.', 'Example: query="ZSALES*" or info_area="ZBENCH".');
  }

  const client = ctx.client();
  const notes: string[] = [];
  let hits: Hit[];
  let header: string;
  if (infoArea) {
    hits = await listInfoArea(client, infoArea);
    header = `InfoArea ${infoArea}`;
    if (query) {
      const re = wildcard(query.includes('*') ? query : `*${query}*`);
      hits = hits.filter((h) => re.test(h.name) || re.test(h.title));
      header += ` matching "${query}"`;
    }
  } else {
    hits = await searchService(client, query, types, notes);
    header = `Search "${query}"`;
  }
  hits = hits.filter((h) => keepType(h, types));
  if (sourceSystem) {
    // A DataSource is unique only with its source system, which the hit's link carries.
    hits = hits.filter(
      (h) => h.type !== 'RSDS' || (h.sourceSystem ? h.sourceSystem.toUpperCase() === sourceSystem : h.href.toUpperCase().includes(`/${sourceSystem}`)),
    );
  }
  if (types.length > 0) header += ` (types ${types.join(', ')})`;
  return formatHits(hits, header, limit, notes);
}
