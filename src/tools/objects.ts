/**
 * bw_read, bw_describe, bw_write and bw_activate: thin handlers over the object adapters and the
 * write engine.
 */
import { isBwType, TYPE_INFO } from '../catalog/types.js';
import type { BwClient } from '../bw/client.js';
import { ensureMediaTypes } from '../bw/discovery.js';
import type { BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import { ToolError, classify } from '../format/errors.js';
import { matchesAny } from '../policy/policy.js';
import { activateObject } from '../engine/activation.js';
import { runWrite, type EngineDeps } from '../engine/write.js';
import { isNotFound, type Detail, type ObjectAdapter, type ObjectReader } from '../objects/adapter.js';
import { ADAPTERS, READERS } from '../objects/registry.js';
import { auditSink } from '../server/audit.js';
import { xref } from './relations.js';
import type { HandlerContext } from './context.js';

function adapterFor(type: unknown, tool: string): ObjectAdapter {
  const t = String(type ?? '').toUpperCase() as BwType;
  const adapter = ADAPTERS[t];
  if (!adapter) {
    throw new ToolError('not_implemented', `${tool} does not support ${t} yet.`, `Supported types: ${Object.keys(ADAPTERS).join(', ')}.`);
  }
  return adapter;
}

async function bw(ctx: HandlerContext): Promise<BwClient> {
  const client = ctx.client() as unknown as BwClient;
  await ensureMediaTypes(client);
  return client;
}

function readerFor(type: unknown): ObjectReader {
  const t = String(type ?? '').toUpperCase() as BwType;
  const reader = READERS[t];
  if (!reader) {
    throw new ToolError('not_implemented', `bw_read does not support ${t} yet.`, `Supported types: ${Object.keys(READERS).join(', ')}.`);
  }
  return reader;
}

export async function bwRead(args: JsonObject, ctx: HandlerContext): Promise<string> {
  const reader = readerFor(args.type);
  const name = String(args.name).trim().toUpperCase();
  const sourceSystem = typeof args.source_system === 'string' ? args.source_system.trim().toUpperCase() : undefined;
  const client = await bw(ctx);
  try {
    return await reader.read(client, name, {
      detail: (args.detail as Detail | undefined) ?? 'summary',
      part: typeof args.part === 'string' ? args.part : undefined,
      sourceSystem,
    });
  } catch (err) {
    if (isNotFound(err)) {
      const what = `${reader.type} ${name}${sourceSystem ? ` (${sourceSystem})` : ''}`;
      throw new ToolError('not_found', `${what} not found.`, `Check the name with bw_search(query="${name.slice(0, 4)}*", types=["${reader.type}"]).`);
    }
    throw err;
  }
}

export async function bwDescribe(args: JsonObject, _ctx: HandlerContext): Promise<string> {
  const adapter = adapterFor(args.type, 'bw_describe');
  return adapter.describe(args.action === 'update' ? 'update' : 'create');
}

export const ENGINE_DEPS: EngineDeps = {
  adapters: ADAPTERS,
  readers: READERS,
  // Query components are ELEM in the repository services (VARIABLE would reach BW as "VARI").
  whereUsed: async (client, type, name, sourceSystem) =>
    (await xref(client, isBwType(type) ? TYPE_INFO[type].searchType : type, name, sourceSystem)).map((h) => ({ type: h.type, name: h.name })),
  activate: activateObject,
  unlock: (client, type, name) => client.unlock(type, name.toLowerCase()),
  prepare: (client) => ensureMediaTypes(client),
};

export async function bwWrite(args: JsonObject, ctx: HandlerContext, deps: EngineDeps = ENGINE_DEPS): Promise<string> {
  const audit = deps.audit ?? auditSink(ctx.config.auditFile);
  return runWrite(
    {
      objects: args.objects as JsonObject[],
      package: typeof args.package === 'string' ? args.package : '$TMP',
      transport: typeof args.transport === 'string' ? args.transport : undefined,
      activate: args.activate !== false,
      validateOnly: args.validate_only === true,
    },
    ctx.config,
    ctx.client() as unknown as BwClient,
    audit ? { ...deps, audit } : deps,
  );
}

export async function bwActivate(args: JsonObject, ctx: HandlerContext, deps: EngineDeps = ENGINE_DEPS): Promise<string> {
  if (args.check_only === true) {
    throw new ToolError('not_implemented', 'check_only is not implemented yet.', 'Call bw_activate without check_only; activation runs the check first.');
  }
  const objects = args.objects as JsonObject[];
  const transport = typeof args.transport === 'string' ? args.transport : undefined;
  const client = ctx.client() as unknown as BwClient;
  await deps.prepare?.(client);
  const audit = deps.audit ?? auditSink(ctx.config.auditFile);
  const lines: string[] = [];
  for (const o of objects) {
    const type = String(o.type).toUpperCase();
    const name = String(o.name).trim().toUpperCase();
    const sourceSystem = typeof o.source_system === 'string' ? o.source_system.trim().toUpperCase() : undefined;
    const adapter = deps.adapters[type as BwType];
    if (!adapter?.activationType && !adapter?.activate) {
      lines.push(`failed    ${type} ${name}: bw_activate does not support ${type} yet`);
      continue;
    }
    try {
      const loc = await adapter.locate(client, name, sourceSystem);
      if (!loc.exists) {
        lines.push(`failed    ${type} ${name}: not found`);
        continue;
      }
      if ((loc.package && !matchesAny(ctx.config.allowedPackages, loc.package)) || (loc.infoArea && !matchesAny(ctx.config.allowedInfoAreas, loc.infoArea))) {
        lines.push(`failed    ${type} ${name}: outside the allowed packages or InfoAreas of this server`);
        continue;
      }
      let r: { ok: boolean; messages: string[]; deactivated: string[] };
      if (adapter.activate) {
        r = await adapter.activate(client, name, transport);
      } else {
        const atype = adapter.activationType!;
        // DTPs and DataSources are activated without a lock handle.
        const standalone = atype === 'dtpa' || atype === 'rsds';
        const handle = standalone ? '' : await client.lock(atype, name.toLowerCase());
        r = await deps.activate(client, atype, name, handle, transport, sourceSystem);
      }
      audit?.({ tool: 'bw_activate', action: 'activate', type, name, ...(sourceSystem ? { source_system: sourceSystem } : {}), ...(transport ? { transport } : {}), result: r.ok ? 'active' : 'failed' });
      lines.push(r.ok ? `active    ${type} ${name}` : `failed    ${type} ${name}: ${r.messages.slice(0, 4).join(' / ') || 'activation failed'}`);
      if (r.deactivated.length > 0) lines.push(`          deactivated by this activation: ${r.deactivated.join(', ')}`);
    } catch (err) {
      const e = classify(err);
      lines.push(`failed    ${type} ${name}: ${e.message}${e.hint ? `\n          hint: ${e.hint}` : ''}`);
    }
  }
  return lines.join('\n');
}
