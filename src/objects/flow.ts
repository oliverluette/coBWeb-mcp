/**
 * Helpers shared by the data-flow readers (TRFN, DTPA, RSDS, LSYS).
 */
import { documentStatus, xmlDecode } from './adapter.js';

/** One attribute of an XML start tag, decoded; undefined when absent. */
export function attr(tag: string, key: string): string | undefined {
  const v = tag.match(new RegExp(`(?:^|[\\s<])${key}="([^"]*)"`))?.[1];
  return v === undefined ? undefined : xmlDecode(v);
}

/** The first start tag of an element, e.g. `<source …>`; '' when absent. */
export function startTag(xml: string, element: string): string {
  return xml.match(new RegExp(`<${element}\\b[^>]*>`))?.[0] ?? '';
}

/**
 * Object status: tlogoProperties/objectStatus when present (the modeling API always serves
 * version M, so adtcore:version says nothing), else the object_status response header.
 */
export function objectStatus(xml: string, header?: string): string | undefined {
  return documentStatus(xml) ?? header ?? undefined;
}

/**
 * A DataSource reference in a flow: BW writes "NAME<blanks>SOURCESYSTEM" (name padded to 30).
 * Returns name and source system; other objects come back unchanged.
 */
export function splitDataSource(type: string, raw: string): { name: string; sourceSystem?: string } {
  if (type.toUpperCase() !== 'RSDS') return { name: raw.trim() };
  if (raw.length > 30 && raw.slice(0, 30).trim()) return { name: raw.slice(0, 30).trim(), sourceSystem: raw.slice(30).trim() || undefined };
  const parts = raw.trim().split(/\s+/);
  return parts.length > 1 ? { name: parts[0], sourceSystem: parts[parts.length - 1] } : { name: parts[0] };
}

export function endLabel(type: string, name: string, sourceSystem?: string): string {
  return `${type} ${name}${sourceSystem ? ` (${sourceSystem})` : ''}`;
}

/** Fixed-width list of names, wrapped at about 100 characters. */
export function wrapNames(names: string[], indent = '  '): string[] {
  const lines: string[] = [];
  let line = '';
  for (const n of names) {
    if (line && line.length + n.length + 2 > 100) {
      lines.push(indent + line);
      line = '';
    }
    line += (line ? ', ' : '') + n;
  }
  if (line) lines.push(indent + line);
  return lines;
}

/** One end of a data flow as given in a spec: {type, name, source_system}. */
export interface FlowEnd {
  type: string;
  name: string;
  sourceSystem?: string;
  /** Part of an InfoObject as source or target: texts, attributes or hierarchy. */
  part?: string;
}

const IOBJ_PARTS: Record<string, string> = { texts: 'TEXT', attributes: 'ATTR', hierarchy: 'HIER' };

export function flowEnd(v: unknown): FlowEnd {
  const o = (v ?? {}) as Record<string, unknown>;
  const ss = typeof o.source_system === 'string' && o.source_system.trim() ? o.source_system.trim().toUpperCase() : undefined;
  const part = typeof o.part === 'string' && IOBJ_PARTS[o.part.toLowerCase()] ? o.part.toLowerCase() : undefined;
  return { type: String(o.type ?? '').toUpperCase(), name: String(o.name ?? '').trim().toUpperCase(), ...(ss ? { sourceSystem: ss } : {}), ...(part ? { part } : {}) };
}

/** "ADSO ZSALES01 → ADSO ZSALES02": the readable identity of a transformation or DTP. */
export function flowIdentity(source: FlowEnd, target: FlowEnd): string {
  return `${endLabel(source.type, source.name, source.sourceSystem ?? source.part)} → ${endLabel(target.type, target.name, target.sourceSystem ?? target.part)}`;
}

/** The ends named in a flow identity, or undefined for a technical name. */
export function parseIdentity(identity: string): { source: FlowEnd; target: FlowEnd } | undefined {
  const parts = identity.split('→');
  if (parts.length !== 2) return undefined;
  const end = (s: string): FlowEnd | undefined => {
    const m = s.trim().match(/^(\S+)\s+(\S+)(?:\s+\((\S+)\))?$/);
    if (!m) return undefined;
    const type = m[1].toUpperCase();
    const extra = m[3] ? (type === 'IOBJ' && IOBJ_PARTS[m[3].toLowerCase()] ? { part: m[3].toLowerCase() } : { sourceSystem: m[3].toUpperCase() }) : {};
    return { type, name: m[2].toUpperCase(), ...extra };
  };
  const source = end(parts[0]);
  const target = end(parts[1]);
  return source && target ? { source, target } : undefined;
}

/** The title BW gives a transformation: "RSDS Z_SFLIGHT SELF -> ADSO ZAISFLIN". */
export function trfnTitle(source: FlowEnd, target: FlowEnd): string {
  // BW names an InfoObject part in the type: "IOBJATTR ZCUSTOMER".
  const side = (e: FlowEnd) => `${e.type}${e.part ? IOBJ_PARTS[e.part] ?? '' : ''} ${e.name}${e.sourceSystem ? ` ${e.sourceSystem}` : ''}`;
  return `${side(source)} -> ${side(target)}`;
}

export function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/\s*->\s*/, ' -> ').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}
