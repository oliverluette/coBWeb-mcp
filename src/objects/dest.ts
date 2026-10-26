/**
 * Open Hub destination (DEST): read and delete.
 *
 * The document is <dest:destination name destinationType sourceTlogo sourceObjnm dbTable> with
 * end-user texts, tlogoProperties, key elements ("#///FIELD"), the field elements (inlineType,
 * InfoObject, conversion routine, compounding) and, for a file destination, fileProperties.
 */
import { bwSeg, MEDIA_TYPES, stripInfoAreaSentinel, type BwClient } from '../bw/client.js';
import { ToolError } from '../format/errors.js';
import { isNotFound, statusText, xmlDecode, type ObjectAdapter, type ObjectReader, type ReadOptions } from './adapter.js';
import { bwDelete } from '../legacy/delete.js';
import { attr, objectStatus } from './flow.js';

export interface DestField {
  name: string;
  label: string;
  type: string;
  infoObject?: string;
  conversion?: string;
  compound: string[];
  key: boolean;
}

export interface DestModel {
  name: string;
  description: string;
  status?: string;
  kind: string;
  sourceType: string;
  source: string;
  table: string;
  infoArea: string;
  package: string;
  fields: DestField[];
  file?: Record<string, string>;
}

const TYPE_WORD: Record<string, string> = { DB: 'database table', FILE: 'file', THJ: 'third-party tool', HANA: 'SAP HANA', DS: 'DataSource' };

export function parseDest(name: string, xml: string, headerStatus?: string): DestModel {
  const root = xml.match(/<(?:\w+:)?destination\b[^>]*>/)?.[0];
  if (!root) throw new ToolError('backend', `DEST ${name.toUpperCase()}: the document has no destination element.`);
  const keys = new Set([...xml.matchAll(/<keyElement>[^<]*#\/\/\/([^<]+)<\/keyElement>/g)].map((m) => m[1].trim()));
  const fields: DestField[] = [...xml.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)].map((m) => {
    const head = `<element ${m[1]}>`;
    const body = m[2];
    const inline = body.match(/<inlineType\b[^>]*>/)?.[0] ?? '';
    const t = attr(inline, 'name') ?? '';
    const len = attr(inline, 'length');
    const prec = attr(inline, 'precision');
    const scale = attr(inline, 'scale');
    const size = prec ? `${prec}${scale ? `,${scale}` : ''}` : len ?? '';
    const fieldName = attr(head, 'name') ?? '';
    return {
      name: fieldName,
      label: xmlDecode(body.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
      type: `${t}${size ? ` ${size}` : ''}`,
      ...(attr(head, 'infoObjectName') ? { infoObject: attr(head, 'infoObjectName') } : {}),
      ...(attr(head, 'conversionRoutine') ? { conversion: attr(head, 'conversionRoutine') } : {}),
      compound: [...body.matchAll(/<compoundInfoObject>([^<]+)<\/compoundInfoObject>/g)].map((c) => c[1].trim().replace(/^#\/\/\//, '')),
      key: keys.has(fieldName),
    };
  });
  const fp = xml.match(/<fileProperties\b[^>]*>/)?.[0];
  const file = fp
    ? Object.fromEntries(
        (['fileName', 'logicalFileName', 'separator', 'fileType', 'serverName', 'targetCodePage'] as const)
          .map((k) => [k, attr(fp, k) ?? ''])
          .concat([['onAppServer', attr(fp, 'isFileOnAppserver') === 'true' ? 'yes' : 'no']])
          .filter(([, v]) => v),
      )
    : undefined;
  return {
    name: attr(root, 'name') || name.toUpperCase(),
    description: xmlDecode(xml.match(/<endUserTexts\b[^>]*\blabel="([^"]*)"/)?.[1] ?? ''),
    status: objectStatus(xml, headerStatus),
    kind: attr(root, 'destinationType') ?? '',
    sourceType: attr(root, 'sourceTlogo') ?? '',
    source: attr(root, 'sourceObjnm') ?? '',
    table: attr(root, 'dbTable') ?? '',
    infoArea: stripInfoAreaSentinel(xml.match(/<infoArea[^>]*>([^<]+)<\/infoArea>/)?.[1]?.trim() ?? ''),
    package: xml.match(/<adt[Cc]ore:packageRef\b[^>]*\badt[Cc]ore:name="([^"]*)"/)?.[1] ?? '',
    fields,
    ...(file ? { file } : {}),
  };
}

export function summarizeDest(m: DestModel, full: boolean): string {
  const target = TYPE_WORD[m.kind] ?? (m.kind || '?');
  const head = `DEST ${m.name} "${m.description}" · ${statusText(m.status)} · ${target}${m.table ? ` ${m.table}` : ''} · source ${m.sourceType} ${m.source} · InfoArea ${m.infoArea || '?'} · package ${m.package || '?'}`;
  const n = Math.max(4, ...m.fields.map((f) => f.name.length));
  const t = Math.max(4, ...m.fields.map((f) => f.type.length));
  const lines = [head, `Fields (${m.fields.length}, key marked *):`];
  for (const f of m.fields) {
    const extra = [f.infoObject && f.infoObject !== f.name ? `InfoObject ${f.infoObject}` : '', full && f.conversion ? `conversion ${f.conversion}` : '', f.compound.length ? `compounded to ${f.compound.join(', ')}` : ''].filter(Boolean);
    lines.push(`  ${f.key ? '*' : ' '} ${f.name.padEnd(n)}  ${f.type.padEnd(t)}  ${f.label}${extra.length ? `  [${extra.join('; ')}]` : ''}`.trimEnd());
  }
  if (m.file) {
    const f = m.file;
    lines.push(`File: ${f['fileName'] || f['logicalFileName'] || '?'}${f['logicalFileName'] && f['fileName'] ? ` (logical ${f['logicalFileName']})` : ''} · ${f['onAppServer'] === 'yes' ? `application server${f['serverName'] ? ` ${f['serverName']}` : ''}` : 'client'}${f['separator'] ? ` · separator ${f['separator']}` : ''}${f['fileType'] ? ` · type ${f['fileType']}` : ''}${f['targetCodePage'] ? ` · code page ${f['targetCodePage']}` : ''}`);
  }
  return lines.join('\n');
}

async function readDoc(client: BwClient, name: string): Promise<{ xml: string; status?: string }> {
  const r = await client.get(`/sap/bw/modeling/dest/${bwSeg(name)}/m`, MEDIA_TYPES['dest']);
  return { xml: r.body, status: r.headers['object_status'] ?? r.headers['OBJECT_STATUS'] };
}

export const destReader: ObjectReader = {
  type: 'DEST',
  label: 'Open Hub destination',
  async locate(client, name) {
    try {
      const { xml, status } = await readDoc(client, name);
      const m = parseDest(name, xml, status);
      return { exists: true, ...(m.infoArea ? { infoArea: m.infoArea } : {}), ...(m.package ? { package: m.package } : {}), active: m.status === 'active' };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },
  async read(client, name, { detail }: ReadOptions) {
    let doc: { xml: string; status?: string };
    try {
      doc = await readDoc(client, name);
    } catch (err) {
      if (isNotFound(err)) throw new ToolError('not_found', `DEST ${name.toUpperCase()} not found.`, `Check the name with bw_search(query="${name.toUpperCase().slice(0, 4)}*", types=["DEST"]).`);
      throw err;
    }
    if (detail === 'raw') return doc.xml;
    return summarizeDest(parseDest(name, doc.xml, doc.status), detail === 'full');
  },
};

/**
 * Open Hub destinations are read and deleted; creating and changing them stays in the BW
 * modeling tools.
 */
export const destAdapter: ObjectAdapter = {
  ...destReader,
  type: 'DEST',
  label: 'Open Hub destination',
  describe: () => 'DEST: read with bw_read; bw_write supports action=delete only (with the where-used check of every delete). Create and change Open Hub destinations in the BW modeling tools.',
  check: (action) => (action === 'delete' ? [] : ['DEST: only action=delete is supported; create and change Open Hub destinations in the BW modeling tools']),
  dependsOn: () => [],
  targetInfoArea: () => undefined,
  async create() {
    throw new ToolError('not_implemented', 'Open Hub destinations cannot be created here.');
  },
  async update() {
    throw new ToolError('not_implemented', 'Open Hub destinations cannot be changed here.');
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'dest', name);
    return { status: 'deleted' };
  },
};
