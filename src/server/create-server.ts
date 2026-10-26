/**
 * MCP server: tools/list from the computed surface, tools/call through
 * one pipeline: offered? → normalize and validate arguments → policy and deny list →
 * handler → size cap. Every failure becomes a tool result with isError.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createClientFromEnv } from '../bw/client.js';
import { catalogEntry, type JsonObject } from '../catalog/tools.js';
import type { Config } from '../config.js';
import { ToolError, classify, errorText } from '../format/errors.js';
import { truncate } from '../format/truncate.js';
import { validateArgs } from '../format/validate.js';
import { log } from '../log.js';
import { flagFor, isDenied, opClassOf } from '../policy/policy.js';
import type { BwLike, Handler, HandlerContext } from '../tools/context.js';
import { HANDLERS, IMPLEMENTED, TOOL_TYPES } from '../tools/index.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { buildInstructions } from './instructions.js';
import { buildSurface, type OfferedTool } from './surface.js';

export interface ServerOptions {
  config: Config;
  /** BW client factory; defaults to a fresh session from the environment per call. */
  client?: () => BwLike;
  handlers?: Readonly<Record<string, Handler>>;
}

export interface ServerState {
  offered: OfferedTool[];
  context: HandlerContext;
  handlers: Readonly<Record<string, Handler>>;
  instructions: string;
}

export function prepare(opts: ServerOptions): ServerState {
  const handlers = opts.handlers ?? HANDLERS;
  const implemented = opts.handlers ? new Set(Object.keys(opts.handlers)) : IMPLEMENTED;
  const offered = buildSurface(opts.config, { implemented, types: opts.handlers ? undefined : TOOL_TYPES });
  const names = offered.map((o) => o.spec.name);
  const actions: Record<string, string[]> = {};
  for (const o of offered) actions[o.spec.name] = o.ctx.actions;
  return {
    offered,
    handlers,
    instructions: buildInstructions(names),
    context: {
      config: opts.config,
      client: opts.client ?? (() => createClientFromEnv()),
      offered: names,
      actions,
    },
  };
}

function whyNotOffered(name: string, state: ServerState): ToolError {
  const spec = catalogEntry(name);
  const offered = state.context.offered.join(', ');
  if (!spec) return new ToolError('validation', `Unknown tool ${name}.`, `Offered tools: ${offered}.`);
  const { config } = state.context;
  if (!config.tools.includes(name)) {
    return new ToolError('not_allowed', `${name} is not part of profile "${config.profile}".`, `Offered tools: ${offered}. The administrator can change COBWEB_PROFILE or COBWEB_TOOLS.`);
  }
  if (!state.handlers[name]) {
    return new ToolError('not_implemented', `${name} is not implemented yet in coBWeb-mcp ${VERSION}.`, `Offered tools: ${offered}.`);
  }
  const actions: (string | undefined)[] = spec.actions.length > 0 ? spec.actions : [undefined];
  if (actions.every((a) => isDenied(config.denyActions, name, a))) {
    return new ToolError('not_allowed', `${name} is denied on this server (COBWEB_DENY_ACTIONS).`, `Offered tools: ${offered}.`);
  }
  const op = opClassOf(name, actions[0]);
  return new ToolError('not_allowed', `${name} is disabled on this server.`, `It needs ${flagFor(op)}=true, set by the administrator.`);
}

function checkDenied(o: OfferedTool, args: JsonObject, state: ServerState): void {
  const deny = state.context.config.denyActions;
  if (deny.length === 0) return;
  const name = o.spec.name;
  const refuse = (what: string) =>
    new ToolError('not_allowed', `${what} is denied on this server (COBWEB_DENY_ACTIONS).`, 'Choose another action or ask the administrator.');
  if (Array.isArray(args.objects)) {
    for (const obj of args.objects as JsonObject[]) {
      const action = typeof obj.action === 'string' ? obj.action : undefined;
      const type = typeof obj.type === 'string' ? obj.type : undefined;
      if (isDenied(deny, name, action, type)) throw refuse(`${name} ${action ?? ''} ${type ?? ''}`.replace(/\s+/g, ' ').trim());
    }
  }
  const action = o.spec.actionParam ? (args[o.spec.actionParam] as string | undefined) : undefined;
  const type = typeof args.type === 'string' ? args.type : undefined;
  if (isDenied(deny, name, action, type)) throw refuse(`${name}${action ? `.${action}` : ''}${type ? ` for ${type}` : ''}`);
}

export async function callTool(name: string, rawArgs: Record<string, unknown> | undefined, state: ServerState): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const offered = state.offered.find((o) => o.spec.name === name);
    if (!offered) throw whyNotOffered(name, state);
    const { value, errors } = validateArgs(offered.schema, rawArgs);
    if (errors.length > 0) {
      throw new ToolError('validation', `Invalid arguments for ${name}: ${errors.join('; ')}.`, 'Fix the listed parameters and call again.');
    }
    checkDenied(offered, value, state);
    const handler = state.handlers[name];
    if (!handler) throw whyNotOffered(name, state);
    const text = await handler(value, state.context);
    log('debug', `${name} ok in ${Date.now() - started} ms, ${text.length} chars`);
    return { content: [{ type: 'text', text: truncate(text, state.context.config.maxResultChars) }] };
  } catch (err) {
    const e = classify(err);
    log('debug', `${name} failed (${e.kind}) in ${Date.now() - started} ms`);
    return { content: [{ type: 'text', text: errorText(e) }], isError: true };
  }
}

export function createServer(opts: ServerOptions): Server {
  const state = prepare(opts);
  const server = new Server(
    { name: SERVER_NAME, title: 'coBWeb-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: state.instructions },
  );
  const tools = state.offered.map((o) => o.definition);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments as Record<string, unknown> | undefined, state),
  );
  return server;
}
