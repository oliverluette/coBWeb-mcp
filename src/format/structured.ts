/**
 * Structured results (COBWEB_STRUCTURED=true) for programs that call coBWeb without a model.
 *
 * A handler returns either text or text plus an envelope built from the same model. The text
 * is what every client gets in `content`; the envelope goes to `structuredContent` only when the
 * tool offers an `outputSchema`, which it does only with the flag on.
 */
import { typeFromSearch } from '../catalog/types.js';
import type { ToolError } from './errors.js';

export interface Envelope {
  schema: string;
  data: unknown;
}

export interface Structured {
  text: string;
  structured: Envelope;
}

export type Answer = string | Structured;

export const UNSTRUCTURED = 'cobweb.unstructured/1';
export const ERROR = 'cobweb.error/1';

export function answer(text: string, schema: string, data: unknown): Structured {
  return { text, structured: { schema, data } };
}

export function textOf(a: Answer): string {
  return typeof a === 'string' ? a : a.text;
}

/** The envelope of an answer; plain text becomes cobweb.unstructured/1. */
export function envelopeOf(a: Answer): Envelope {
  return typeof a === 'string' ? { schema: UNSTRUCTURED, data: null } : a.structured;
}

export function errorEnvelope(e: ToolError): Envelope {
  return { schema: ERROR, data: { kind: e.kind, message: e.message, hint: e.hint ?? null } };
}

const KNOWN_STATUS = new Set(['active', 'inactive', 'revised', 'new']);

/**
 * Status as a known value; anything else becomes "unknown" with the raw value beside it.
 * `empty` is what an object without any status gets (null for a source system).
 */
export function statusFields(raw: string | undefined | null, empty: null | 'unknown' = 'unknown'): { status: string | null; status_raw?: string } {
  const v = (raw ?? '').trim();
  if (!v) return { status: empty };
  const lower = v.toLowerCase();
  if (KNOWN_STATUS.has(lower)) return { status: lower };
  if (lower === 'unknown') return { status: 'unknown' };
  return { status: 'unknown', status_raw: v };
}

const IOBJ_PART: Record<string, string> = {
  ATTR: 'attr',
  TEXT: 'text',
  HIER: 'hier',
  ATTRIBUTES: 'attr',
  TEXTS: 'text',
  HIERARCHY: 'hier',
};

export interface ObjectRef {
  ref: string;
  type: string;
  name: string;
  source_system?: string;
  part?: string;
  sub_type?: string;
}

/**
 * One object in the terms of all structured results: query elements as QUERY, VARIABLE …
 * instead of ELEM, InfoObject parts (attributes, texts, hierarchy) as `part`.
 */
export function objectRef(type: string, name: string, sourceSystem?: string, subType?: string): ObjectRef {
  let t = type.toUpperCase();
  let sub = subType?.trim().toUpperCase() || undefined;
  if (t.startsWith('ELEM/')) {
    sub = t.slice(5);
    t = 'ELEM';
  }
  const fused = t.match(/^IOBJ(ATTR|TEXT|HIER)$/);
  if (fused) {
    t = 'IOBJ';
    sub = fused[1];
  }
  let part: string | undefined;
  if (t === 'ELEM' && sub) {
    const mapped = typeFromSearch('ELEM', sub);
    if (!mapped.startsWith('ELEM/')) {
      t = mapped;
      sub = undefined;
    }
  } else if (t === 'IOBJ' && sub && IOBJ_PART[sub]) {
    part = IOBJ_PART[sub];
    sub = undefined;
  }
  const n = name.trim();
  const ss = sourceSystem?.trim().toUpperCase() || undefined;
  const ref = [t, n, ...(ss ? [ss] : []), ...(part ? [part] : [])].join(':');
  return { ref, type: t, name: n, ...(ss ? { source_system: ss } : {}), ...(part ? { part } : {}), ...(sub ? { sub_type: sub } : {}) };
}

/** A number from a BW attribute, or null. */
export function numberOrNull(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** cobweb.object_head/1: the head of an object a program knows only by name. */
export function objectHead(
  ref: ObjectRef,
  head: { status?: string; description: string; infoArea?: string; package?: string; keys?: string[] },
): Envelope {
  return {
    schema: 'cobweb.object_head/1',
    data: {
      ...ref,
      ...statusFields(head.status),
      description: head.description,
      info_area: head.infoArea ?? null,
      package: head.package ?? null,
      ...(head.keys ? { keys: head.keys } : {}),
    },
  };
}

/** part="head" and part="keys" carry the object head in the structured result. */
export function isHeadPart(part: string | undefined): 'head' | 'keys' | undefined {
  const p = part?.toLowerCase();
  return p === 'head' || p === 'keys' ? p : undefined;
}
