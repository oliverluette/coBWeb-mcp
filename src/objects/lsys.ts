/**
 * Source system (LSYS): read only.
 */
import type { BwClient } from '../bw/client.js';
import { isNotFound, statusText, xmlDecode, type ObjectReader, type ReadOptions } from './adapter.js';
import { attr, objectStatus } from './flow.js';
import { bwListRemoteEntities } from '../legacy/datasource.js';

const LSYS_ACCEPT = 'application/vnd.sap.bw.modeling.lsys-v1_0_0+xml, application/vnd.sap.bw.modeling.lsys-v1_1_0+xml';

export function summarizeLsys(name: string, xml: string, headerStatus?: string): string {
  const root = xml.match(/<lsys:sourceSystem\b[^>]*>/)?.[0] ?? '';
  const xsi = (attr(root, 'xsi:type') ?? '').replace(/^lsys:/, '').replace(/^SourceSystem/, '');
  const hanaType = attr(root, 'hanaType');
  const kind = xsi === 'HANA' ? (hanaType === '1' ? 'HANA local' : 'HANA smart data access') : xsi || attr(root, 'type') || '?';
  const label = xmlDecode(xml.match(/<(?:descriptions?|endUserTexts)\b[^>]*\blabel="([^"]*)"/)?.[1] ?? '');
  const details = [
    ['context', attr(root, 'context')],
    ['destination', attr(root, 'destination')],
    ['remote source', attr(root, 'remoteSource')],
    ['schema', attr(root, 'schema')],
    ['database', attr(root, 'database')],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`);
  return [`LSYS ${name.toUpperCase()} "${label}" · ${statusText(objectStatus(xml, headerStatus))} · ${kind}`, ...(details.length ? [details.join(' · ')] : [])].join('\n');
}

const ENTITY_KIND: Record<string, string> = { T: 'tables', V: 'views', D: 'DataSources', E: 'extractors', C: 'CDS views' };

/** The entity list of a source system as name lists per kind, instead of one JSON object per entity. */
export function summarizeEntities(json: string): string {
  let r: { source_system?: string; search_pattern?: string; result_complete?: boolean; count?: number; entities?: Array<{ technical_name: string; entity_type: string; path_suffix?: string }> };
  try {
    r = JSON.parse(json);
  } catch {
    return json;
  }
  const groups = new Map<string, string[]>();
  for (const e of r.entities ?? []) {
    const kind = ENTITY_KIND[e.entity_type] ?? `type ${e.entity_type}`;
    groups.set(kind, [...(groups.get(kind) ?? []), `${e.technical_name}${e.path_suffix ? ` (${e.path_suffix})` : ''}`]);
  }
  const head = `Entities of ${r.source_system ?? '?'} matching ${r.search_pattern ?? '*'}: ${r.count ?? 0}${r.result_complete === false ? ' (more exist; narrow the pattern: part="entities:ABC*")' : ''}`;
  return [head, ...[...groups].map(([k, names]) => `${k} (${names.length}): ${names.join(', ')}`)].join('\n');
}

async function readDoc(client: BwClient, name: string): Promise<{ xml: string; status?: string }> {
  const r = await client.get(`/sap/bw/modeling/lsys/${name.toLowerCase()}/a`, LSYS_ACCEPT);
  return { xml: r.body, status: r.headers['object_status'] };
}

export const lsysReader: ObjectReader = {
  type: 'LSYS',
  label: 'Source system',
  async locate(client, name) {
    try {
      await readDoc(client, name);
      return { exists: true };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },
  async read(client, name, { detail, part }: ReadOptions) {
    // part="entities" or "entities:<pattern>": the ODP/remote entities the source system offers.
    const ent = part?.match(/^entities(?::(.+))?$/i);
    if (ent) return summarizeEntities(await bwListRemoteEntities(client as never, name, ent[1] ?? '*'));
    const { xml, status } = await readDoc(client, name);
    return detail === 'raw' ? xml : summarizeLsys(name, xml, status);
  },
};
