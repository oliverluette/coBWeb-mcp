/** Object adapters and readers available in this version, by type. */
import type { BwType } from '../catalog/types.js';
import type { ObjectAdapter, ObjectReader } from './adapter.js';
import { areaAdapter } from './area.js';
import { iobjAdapter } from './iobj.js';
import { adsoAdapter } from './adso.js';
import { hcprAdapter } from './hcpr.js';
import { trcsAdapter } from './trcs.js';
import { trfnAdapter } from './trfn.js';
import { dtpaAdapter } from './dtpa.js';
import { rsdsAdapter } from './rsds.js';
import { lsysReader } from './lsys.js';
import { queryAdapter } from './query.js';
import { ckfAdapter, rkfAdapter, structureAdapter, variableAdapter } from './components.js';
import { alvlAdapter, filterAdapter, plseAdapter, plsqAdapter } from './planning.js';
import { hierAdapter } from './hierarchy.js';
import { rspcAdapter } from './rspc.js';
import { destAdapter } from './dest.js';
import { roleReader } from './role.js';

/** Types bw_write, bw_describe and bw_activate support. */
export const ADAPTERS: Partial<Record<BwType, ObjectAdapter>> = {
  AREA: areaAdapter,
  IOBJ: iobjAdapter,
  ADSO: adsoAdapter,
  HCPR: hcprAdapter,
  TRCS: trcsAdapter,
  TRFN: trfnAdapter,
  DTPA: dtpaAdapter,
  RSDS: rsdsAdapter,
  QUERY: queryAdapter,
  VARIABLE: variableAdapter,
  CKF: ckfAdapter,
  RKF: rkfAdapter,
  STRUCTURE: structureAdapter,
  ALVL: alvlAdapter,
  FILTER: filterAdapter,
  PLSE: plseAdapter,
  PLSQ: plsqAdapter,
  RSPC: rspcAdapter,
  HIER: hierAdapter,
  DEST: destAdapter,
};

/** Types bw_read supports: every adapter plus the read-only types. */
export const READERS: Partial<Record<BwType, ObjectReader>> = {
  ...ADAPTERS,
  LSYS: lsysReader,
  ROLE: roleReader,
};

export const ADAPTER_TYPES = Object.keys(ADAPTERS) as BwType[];
export const READER_TYPES = Object.keys(READERS) as BwType[];
export const ACTIVATABLE_TYPES = ADAPTER_TYPES.filter((t) => ADAPTERS[t]?.activationType || ADAPTERS[t]?.activate);
