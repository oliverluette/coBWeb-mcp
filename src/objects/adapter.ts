/**
 * Object adapters: one module per BW object type.
 *
 * An adapter knows how to read, summarize, check, create, update and delete its type. The tools
 * (bw_read, bw_describe, bw_write, bw_activate) and the write engine only talk to adapters, so a
 * new object type needs an adapter and policy entries, never a new tool.
 */
import type { BwClient } from '../bw/client.js';
import type { BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';

export type WriteAction = 'create' | 'update' | 'delete';
export type Detail = 'summary' | 'full' | 'raw';
export type Spec = JsonObject;

export interface ObjectRef {
  type: BwType;
  name: string;
}

/**
 * Boundary reference to an InfoProvider whose type the spec does not say (a query or a query
 * component names its provider only). The engine looks it up as CompositeProvider, DataStore
 * object or InfoObject, in that order.
 */
export const PROVIDER = 'PROVIDER' as BwType;
export const PROVIDER_TYPES: BwType[] = ['HCPR', 'ADSO', 'IOBJ'];

export interface Location {
  exists: boolean;
  infoArea?: string;
  package?: string;
  /** The technical name, when the object was found by its identity (TRFN, DTPA). */
  name?: string;
  /** false when the object exists but is not active (saved only, or deactivated). */
  active?: boolean;
}

export interface WriteContext {
  client: BwClient;
  package: string;
  transport?: string;
  /** Only for DataSources (RSDS). */
  sourceSystem?: string;
}

export interface WriteOutcome {
  status: 'created' | 'changed' | 'unchanged' | 'deleted';
  /**
   * Present when the object waits for activation: the lock handle the save left in place,
   * or '' when the object is not locked any more.
   */
  activation?: { lockHandle: string };
  /** The adapter already activated the object (some BW write paths activate on their own). */
  activated?: boolean;
  /** Short facts for the result line, e.g. "key figure AMO, fixed currency EUR". */
  notes?: string[];
  /** The technical name BW generated on create (TRFN, DTPA). */
  name?: string;
  /** Hint for the result line when the activation fails, instead of the general one. */
  activationHint?: string;
}

/** Read access to one object type; every adapter is a reader, some types are read-only. */
export interface ObjectReader {
  type: BwType;
  label: string;
  /** Does the object exist, and where does it live? sourceSystem only for RSDS. */
  locate(client: BwClient, name: string, sourceSystem?: string): Promise<Location>;
  read(client: BwClient, name: string, opts: ReadOptions): Promise<string>;
}

export interface ReadOptions {
  detail: Detail;
  part?: string;
  /** Only for DataSources (RSDS). */
  sourceSystem?: string;
}

export interface ObjectAdapter extends ObjectReader {
  type: BwType;
  label: string;
  /** Collection key used for activation; undefined when the object is active on save (AREA). */
  activationType?: string;
  /** Text for bw_describe, at most 4,000 characters. */
  describe(action: 'create' | 'update'): string;
  /** Strict check of a spec before any BW access; returns the problems, empty when valid. */
  check(action: WriteAction, name: string, spec: Spec | undefined): string[];
  /** Objects this one needs; within one bw_write call they are written first. */
  dependsOn(action: WriteAction, name: string, spec: Spec | undefined): ObjectRef[];
  /** The InfoArea a create places the object in (for COBWEB_ALLOWED_INFOAREAS). */
  targetInfoArea(name: string, spec: Spec): string | undefined;
  /**
   * For types whose name BW generates (TRFN, DTPA): a readable identity built from the spec,
   * e.g. "ADSO ZSALES01 → ADSO ZSALES02". A create may then omit the name; locate() accepts
   * the identity and returns the technical name of an existing object.
   */
  identity?(spec: Spec): string;
  /**
   * Existing objects a create writes into (e.g. the target of a transformation). Their
   * InfoArea must be allowed (COBWEB_ALLOWED_INFOAREAS) when the object itself has none.
   */
  boundary?(spec: Spec): ObjectRef[];
  /**
   * Activation of its own, for types BW activates outside the modeling API (process chains).
   * Used instead of activationType by bw_write and bw_activate; a write that leaves the object
   * to be activated returns activation: { lockHandle: '' }.
   */
  activate?(client: BwClient, name: string, transport?: string): Promise<{ ok: boolean; messages: string[]; deactivated: string[] }>;
  create(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome>;
  update(name: string, spec: Spec, ctx: WriteContext): Promise<WriteOutcome>;
  delete(name: string, ctx: WriteContext): Promise<WriteOutcome>;
}

/** HTTP 404 from the BW client. */
export function isNotFound(err: unknown): boolean {
  return /HTTP 404\b/.test(err instanceof Error ? err.message : String(err));
}

/** Escape a value for an XML attribute or text node. */
export function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function xmlDecode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Status of a modeling document: objectStatus, and "revised" for an active object whose
 * saved version holds changes not activated yet (contentState REV).
 */
export function documentStatus(xml: string): string | undefined {
  const status = xml.match(/<objectStatus>([^<]*)<\/objectStatus>/)?.[1];
  const content = xml.match(/<contentState>([^<]*)<\/contentState>/)?.[1];
  if (content === 'REV') return 'revised';
  return status ?? ({ ACT: 'active', NEW: 'new' } as Record<string, string>)[content ?? ''];
}

/** Package and InfoArea of a modeling document (tlogoProperties). */
export function locationFromXml(xml: string): Location {
  const status = documentStatus(xml)?.toLowerCase();
  return {
    exists: true,
    infoArea: xml.match(/<infoArea>([^<]*)<\/infoArea>/)?.[1] || undefined,
    package: xml.match(/<adtcore:packageRef\b[^>]*\badtcore:name="([^"]*)"/)?.[1] || undefined,
    ...(status ? { active: status === 'active' } : {}),
  };
}

/** Status in fixed terms: the modeling API always serves version M, so it says nothing. */
export function statusText(objectStatus: string | undefined): string {
  switch ((objectStatus ?? '').toLowerCase()) {
    case 'active':
      return 'active';
    case 'inactive':
      return 'inactive (saved, not activated)';
    case 'revised':
      return 'active, with saved changes not activated';
    case 'new':
      return 'new, never activated';
    default:
      return objectStatus ? objectStatus.toLowerCase() : 'unknown';
  }
}
