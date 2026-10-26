/**
 * BW object types addressed by coBWeb, as TLOGO-style codes.
 *
 * The code is what the model passes as `type`. `collections` are the keys of the BW modeling
 * REST API (`/sap/bw/modeling/<collection>`) that serve the type; a classic release names some
 * of them differently (`infoobject` instead of `iobj`). `searchType` is the type filter of the
 * BW search service; query components share the TLOGO `ELEM` and differ by subtype there.
 */
export const BW_TYPES = [
  'AREA',
  'IOBJ',
  'ADSO',
  'HCPR',
  'TRCS',
  'TRFN',
  'DTPA',
  'RSDS',
  'LSYS',
  'RSPC',
  'QUERY',
  'VARIABLE',
  'CKF',
  'RKF',
  'STRUCTURE',
  'ALVL',
  'PLSE',
  'PLSQ',
  'FILTER',
  'DEST',
  'ROLE',
  'HIER',
] as const;

export type BwType = (typeof BW_TYPES)[number];

export interface TypeInfo {
  label: string;
  collections: string[];
  searchType: string;
  /** Subtype of ELEM in the search feed, where the type is a query component. */
  elemSubtype?: string;
}

export const TYPE_INFO: Record<BwType, TypeInfo> = {
  AREA: { label: 'InfoArea', collections: ['area'], searchType: 'AREA' },
  IOBJ: { label: 'InfoObject', collections: ['iobj', 'infoobject'], searchType: 'IOBJ' },
  ADSO: { label: 'DataStore object (advanced)', collections: ['adso'], searchType: 'ADSO' },
  HCPR: { label: 'CompositeProvider', collections: ['hcpr'], searchType: 'HCPR' },
  TRCS: { label: 'InfoSource', collections: ['trcs'], searchType: 'TRCS' },
  TRFN: { label: 'Transformation', collections: ['trfn'], searchType: 'TRFN' },
  DTPA: { label: 'Data transfer process', collections: ['dtpa'], searchType: 'DTPA' },
  RSDS: { label: 'DataSource', collections: ['rsds'], searchType: 'RSDS' },
  LSYS: { label: 'Source system', collections: ['lsys'], searchType: 'LSYS' },
  RSPC: { label: 'Process chain', collections: ['rspc'], searchType: 'RSPC' },
  QUERY: { label: 'Query', collections: ['query'], searchType: 'ELEM', elemSubtype: 'REP' },
  VARIABLE: { label: 'Variable', collections: ['variable'], searchType: 'ELEM', elemSubtype: 'VAR' },
  CKF: { label: 'Calculated key figure', collections: ['ckf'], searchType: 'ELEM', elemSubtype: 'CKF' },
  RKF: { label: 'Restricted key figure', collections: ['rkf'], searchType: 'ELEM', elemSubtype: 'RKF' },
  STRUCTURE: { label: 'Structure', collections: ['structure'], searchType: 'ELEM', elemSubtype: 'STR' },
  ALVL: { label: 'Aggregation level', collections: ['alvl'], searchType: 'ALVL' },
  PLSE: { label: 'Planning function', collections: ['plse'], searchType: 'PLSE' },
  PLSQ: { label: 'Planning sequence', collections: ['plsq'], searchType: 'PLSQ' },
  FILTER: { label: 'Planning filter', collections: ['filter'], searchType: 'ELEM', elemSubtype: 'SOB' },
  DEST: { label: 'Open Hub destination', collections: ['dest'], searchType: 'DEST' },
  ROLE: { label: 'Role (published queries)', collections: [], searchType: 'ROLE' },
  HIER: { label: 'Hierarchy', collections: ['hier'], searchType: 'HIER' },
};

export function isBwType(value: string): value is BwType {
  return (BW_TYPES as readonly string[]).includes(value);
}

/** Map an entry of the search feed back to a coBWeb type code, where one exists. */
export function typeFromSearch(objectType: string, subtype?: string): string {
  const t = objectType.toUpperCase();
  if (t === 'ELEM' && subtype) {
    const hit = BW_TYPES.find((code) => TYPE_INFO[code].elemSubtype === subtype.toUpperCase());
    return hit ?? `ELEM/${subtype.toUpperCase()}`;
  }
  return t;
}
