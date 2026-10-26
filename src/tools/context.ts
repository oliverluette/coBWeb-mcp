import type { JsonObject } from '../catalog/tools.js';
import type { Config } from '../config.js';

/** The part of the BW client the tools use; tests pass a fake. */
export interface BwLike {
  get(path: string, accept: string): Promise<{ body: string; headers: Record<string, string> }>;
  unlock(type: string, name: string): Promise<void>;
}

export interface HandlerContext {
  config: Config;
  /** A BW client for this call (a fresh session, see bw/client.ts createClientFromEnv). */
  client: () => BwLike;
  /** Tools offered by this server instance, in catalog order. */
  offered: readonly string[];
  /** Actions enabled per offered tool. */
  actions: Readonly<Record<string, readonly string[]>>;
}

export type Handler = (args: JsonObject, ctx: HandlerContext) => Promise<string>;
