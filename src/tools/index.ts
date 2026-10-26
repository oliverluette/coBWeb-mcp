/**
 * Implemented tool handlers. A catalog tool without a handler is not offered, and the object
 * types of the object tools are limited to the types that have an adapter.
 */
import type { BwType } from '../catalog/types.js';
import { ACTIVATABLE_TYPES, ADAPTER_TYPES, READER_TYPES } from '../objects/registry.js';
import type { Handler } from './context.js';
import { bwActivate, bwDescribe, bwRead, bwWrite } from './objects.js';
import { bwContext } from './relations.js';
import { bwSearch } from './search.js';
import { bwSystem } from './system.js';
import { bwData, bwMonitor, bwRun, bwTransport } from './runtime.js';

export const HANDLERS: Readonly<Record<string, Handler>> = {
  bw_search: bwSearch,
  bw_read: bwRead,
  bw_context: bwContext,
  bw_describe: bwDescribe,
  bw_write: (args, ctx) => bwWrite(args, ctx),
  bw_activate: (args, ctx) => bwActivate(args, ctx),
  bw_data: bwData,
  bw_monitor: bwMonitor,
  bw_run: bwRun,
  bw_transport: bwTransport,
  bw_system: bwSystem,
};

export const IMPLEMENTED: ReadonlySet<string> = new Set(Object.keys(HANDLERS));

/** Object types each object tool supports in this version. */
export const TOOL_TYPES: Readonly<Record<string, readonly BwType[]>> = {
  bw_read: READER_TYPES,
  bw_describe: ADAPTER_TYPES,
  bw_write: ADAPTER_TYPES,
  bw_activate: ACTIVATABLE_TYPES,
};
