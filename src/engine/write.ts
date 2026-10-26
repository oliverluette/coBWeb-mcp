/**
 * The write flow of bw_write.
 *
 *  1  policy: package and InfoArea limits            → stop before any BW access
 *  2  check every spec strictly                       → report all problems at once
 *  3  order by dependency (AREA, IOBJ, providers, …); deletes last, in reverse order
 *  4  per dependency level: write each object (create, update, or "unchanged"),
 *     then activate the level before the next one is written, so an ADSO is saved
 *     against active InfoObjects
 *  5  one result line per object
 *
 * BW has no transaction across objects. The flow is repeatable instead: calling it again
 * with the same objects reports finished ones as unchanged and retries the failed ones.
 */
import type { BwClient } from '../bw/client.js';
import { isBwType, type BwType } from '../catalog/types.js';
import type { JsonObject } from '../catalog/tools.js';
import type { Config } from '../config.js';
import { ToolError, classify } from '../format/errors.js';
import { matchesAny } from '../policy/policy.js';
import type { AuditSink } from '../server/audit.js';
import type { Location, ObjectAdapter, ObjectReader, Spec, WriteAction, WriteContext, WriteOutcome } from '../objects/adapter.js';
import { PROVIDER, PROVIDER_TYPES } from '../objects/adapter.js';

const RANK: Record<BwType, number> = {
  AREA: 0,
  LSYS: 0,
  IOBJ: 1,
  ADSO: 2,
  TRCS: 2,
  RSDS: 2,
  HCPR: 3,
  DEST: 3,
  ALVL: 4,
  TRFN: 4,
  VARIABLE: 4,
  DTPA: 5,
  QUERY: 7,
  CKF: 5,
  RKF: 5,
  STRUCTURE: 6,
  PLSE: 5,
  RSPC: 8,
  PLSQ: 8,
  FILTER: 5,
  HIER: 2,
  ROLE: 0,
};

export interface WriteItem {
  index: number;
  action: WriteAction;
  type: BwType;
  /** Technical name, or the identity ("ADSO A → ADSO B") of a TRFN or DTPA created without one. */
  name: string;
  spec?: Spec;
  sourceSystem?: string;
}

type Status = 'created' | 'changed' | 'unchanged' | 'deleted' | 'failed' | 'skipped';

export interface ItemResult {
  item: WriteItem;
  status: Status;
  /** Technical name when it differs from item.name (generated or found by identity). */
  realName?: string;
  activation?: 'active' | 'inactive' | 'failed';
  message?: string;
  hint?: string;
  notes: string[];
  deactivated: string[];
}

export interface ActivationResult {
  ok: boolean;
  messages: string[];
  deactivated: string[];
}

export interface EngineDeps {
  adapters: Partial<Record<BwType, ObjectAdapter>>;
  /** Readers for the boundary check of TRFN and DTPA (the objects they write into). */
  readers?: Partial<Record<BwType, ObjectReader>>;
  activate: (client: BwClient, type: string, name: string, lockHandle: string, transport?: string, sourceSystem?: string) => Promise<ActivationResult>;
  unlock: (client: BwClient, type: string, name: string) => Promise<void>;
  /** Called once after the request passed the checks, before the first BW access. */
  prepare?: (client: BwClient) => Promise<void>;
  /** Objects that reference an object (where-used); a delete is refused while others use it. */
  whereUsed?: (client: BwClient, type: string, name: string, sourceSystem?: string) => Promise<{ type: string; name: string }[]>;
  audit?: AuditSink;
}

/** Types whose where-used list is checked before a delete. */
const CHECK_USAGE: ReadonlySet<string> = new Set(['IOBJ', 'ADSO', 'HCPR', 'TRCS', 'TRFN', 'DTPA', 'RSDS', 'VARIABLE', 'CKF', 'RKF', 'STRUCTURE']);

export interface WriteInput {
  objects: JsonObject[];
  package: string;
  transport?: string;
  activate: boolean;
  /** Check everything against BW, write nothing. */
  validateOnly?: boolean;
}

function key(type: string, name: string): string {
  return `${type}/${name}`;
}

/** Parse, check and authorize the request. Throws before any BW access when something is wrong. */
export function plan(input: WriteInput, config: Config, adapters: EngineDeps['adapters']): WriteItem[] {
  const pkg = input.package.toUpperCase();
  if (!matchesAny(config.allowedPackages, pkg)) {
    throw new ToolError(
      'not_allowed',
      `Writing to package ${pkg} is not allowed on this server (allowed: ${config.allowedPackages.join(', ')}).`,
      'Use an allowed package, e.g. $TMP.',
    );
  }
  const items: WriteItem[] = [];
  const problems: string[] = [];
  const denied: string[] = [];
  const seen = new Set<string>();
  input.objects.forEach((o, index) => {
    const type = String(o.type ?? '').toUpperCase();
    let name = String(o.name ?? '').trim().toUpperCase();
    const action = String(o.action ?? '') as WriteAction;
    let where = `${type} ${name || `#${index + 1}`}`;
    if (!isBwType(type)) {
      problems.push(`${where}: unknown type`);
      return;
    }
    const adapter = adapters[type];
    if (!adapter) {
      problems.push(`${where}: bw_write does not support ${type} yet (supported: ${Object.keys(adapters).join(', ')})`);
      return;
    }
    const spec = o.spec as Spec | undefined;
    if (action !== 'delete' && spec === undefined) problems.push(`${where}: spec is required for ${action}`);
    const checks = adapter.check(action, name, spec);
    for (const p of checks) problems.push(`${where}: ${p}`);
    if (!name) {
      if (action === 'create' && adapter.identity && spec && checks.length === 0) {
        // The identity is upper case already; only an InfoObject part reads in lower case.
        name = adapter.identity(spec);
        where = `${type} ${name}`;
      } else if (action !== 'create' || !adapter.identity) {
        problems.push(`${where}: name is required${adapter.identity ? ` to ${action} a ${type}` : ''}`);
      }
    }
    if (name && seen.has(key(type, name))) problems.push(`${where}: listed twice`);
    seen.add(key(type, name));
    if (action === 'create' && spec) {
      const area = adapter.targetInfoArea(name, spec);
      if (area && !matchesAny(config.allowedInfoAreas, area)) denied.push(`${where}: InfoArea ${area} is not allowed (allowed: ${config.allowedInfoAreas.join(', ')})`);
    }
    const sourceSystem = typeof o.source_system === 'string' && o.source_system.trim() ? o.source_system.trim().toUpperCase() : undefined;
    items.push({ index, action, type, name, spec, sourceSystem });
  });
  if (denied.length > 0) {
    throw new ToolError('not_allowed', `Nothing was written. ${denied.join('; ')}.`, 'Use an allowed InfoArea or ask the administrator (COBWEB_ALLOWED_INFOAREAS).');
  }
  if (problems.length > 0) {
    throw new ToolError(
      'validation',
      `Nothing was written. ${problems.join('; ')}.`,
      'Fix the listed objects and call again. bw_describe(type) returns the spec format.',
    );
  }
  return items;
}

function levels(items: WriteItem[]): WriteItem[][] {
  const byRank = new Map<number, WriteItem[]>();
  for (const it of items.filter((i) => i.action !== 'delete')) {
    const r = RANK[it.type];
    byRank.set(r, [...(byRank.get(r) ?? []), it]);
  }
  return [...byRank.keys()].sort((a, b) => a - b).map((r) => byRank.get(r)!);
}

export async function runWrite(input: WriteInput, config: Config, client: BwClient, deps: EngineDeps): Promise<string> {
  const items = plan(input, config, deps.adapters);
  await deps.prepare?.(client);
  if (input.validateOnly) return validate(items, input, config, client, deps);
  const ctx: WriteContext = { client, package: input.package.toUpperCase(), transport: input.transport };
  const itemCtx = (it: WriteItem): WriteContext => (it.sourceSystem ? { ...ctx, sourceSystem: it.sourceSystem } : ctx);
  const results = new Map<string, ItemResult>();
  const inCall = new Set(items.map((i) => key(i.type, i.name)));

  const blockedBy = (it: WriteItem): string | undefined => {
    const adapter = deps.adapters[it.type]!;
    for (const ref of adapter.dependsOn(it.action, it.name, it.spec)) {
      const k = key(ref.type, ref.name);
      if (!inCall.has(k)) continue;
      const r = results.get(k);
      if (r && (r.status === 'failed' || r.status === 'skipped' || r.activation === 'failed')) {
        return `needs ${ref.type} ${ref.name}, which ${r.status === 'skipped' ? 'was skipped' : 'failed'}`;
      }
    }
    return undefined;
  };

  const outOfBounds = (it: WriteItem, loc: { infoArea?: string; package?: string }): string | undefined => {
    if (loc.package && !matchesAny(config.allowedPackages, loc.package)) return `it is in package ${loc.package}, which is not allowed`;
    if (loc.infoArea && !matchesAny(config.allowedInfoAreas, loc.infoArea)) return `it is in InfoArea ${loc.infoArea}, which is not allowed`;
    return undefined;
  };

  /** Objects that use this one and are not deleted in the same call. */
  const deletedInCall = new Set(items.filter((i) => i.action === 'delete').map((i) => `${i.type}/${i.name}`));
  const usage = new Map<string, Promise<{ type: string; name: string }[]>>();
  const usedBy = (type: string, name: string, sourceSystem?: string): Promise<{ type: string; name: string }[]> => {
    const k = `${type}/${name}/${sourceSystem ?? ''}`;
    if (!usage.has(k)) usage.set(k, deps.whereUsed!(client, type, name, sourceSystem));
    return usage.get(k)!;
  };
  const usersOutsideCall = async (it: WriteItem, real: string): Promise<{ type: string; name: string }[]> => {
    if (!deps.whereUsed || !CHECK_USAGE.has(it.type)) return [];
    const users = await usedBy(it.type, real, it.sourceSystem);
    return users.filter((u) => !deletedInCall.has(`${u.type}/${u.name.toUpperCase()}`) && !(u.type === it.type && u.name.toUpperCase() === real));
  };

  /** An InfoProvider by name: the first of the provider types under which it exists. */
  const locateProvider = async (name: string): Promise<Location | undefined> => {
    for (const t of PROVIDER_TYPES) {
      const reader = deps.readers?.[t] ?? deps.adapters[t];
      if (!reader) continue;
      const loc = await reader.locate(client, name).catch(() => undefined);
      if (loc?.exists) return loc;
    }
    return undefined;
  };

  /**
   * Objects a create or update needs that are neither in this call nor in BW. BW answers a missing
   * InfoObject with misleading text ("The object name is not allowed to be empty") and may leave an
   * empty shell behind, so this is checked before writing.
   */
  const found = new Map<string, Promise<boolean>>();
  const missingRefs = async (it: WriteItem, adapter: ObjectAdapter): Promise<string[]> => {
    const missing: string[] = [];
    for (const ref of adapter.dependsOn(it.action, it.name, it.spec)) {
      if (inCall.has(key(ref.type, ref.name)) || ref.type === 'TRFN' || ref.type === 'DTPA') continue;
      const k = `${ref.type}/${ref.name}`;
      if (!found.has(k)) {
        found.set(
          k,
          ref.type === PROVIDER
            ? locateProvider(ref.name).then((l) => l?.exists !== false, () => true)
            : (async () => {
                const reader = deps.readers?.[ref.type] ?? deps.adapters[ref.type];
                if (!reader) return true;
                return reader.locate(client, ref.name).then((l) => l.exists, () => true);
              })(),
        );
      }
      if (!(await found.get(k))) missing.push(`${ref.type === PROVIDER ? 'InfoProvider' : ref.type} ${ref.name}`);
    }
    return missing;
  };

  /** A TRFN or DTPA writes into existing objects; their InfoArea must be allowed. */
  const boundaryProblem = async (it: WriteItem, adapter: ObjectAdapter): Promise<string | undefined> => {
    for (const ref of adapter.boundary?.(it.spec ?? {}) ?? []) {
      if (ref.type === PROVIDER) {
        const loc = await locateProvider(ref.name);
        if (loc?.infoArea && !matchesAny(config.allowedInfoAreas, loc.infoArea)) return `InfoProvider ${ref.name} is in InfoArea ${loc.infoArea}, which is not allowed`;
        continue;
      }
      const reader = deps.readers?.[ref.type] ?? deps.adapters[ref.type];
      if (!reader) continue;
      const loc: Location = await reader.locate(client, ref.name);
      if (loc.infoArea && !matchesAny(config.allowedInfoAreas, loc.infoArea)) {
        return `${ref.type} ${ref.name} is in InfoArea ${loc.infoArea}, which is not allowed`;
      }
    }
    return undefined;
  };

  async function writeOne(it: WriteItem): Promise<{ result: ItemResult; outcome?: WriteOutcome }> {
    const adapter = deps.adapters[it.type]!;
    const base: ItemResult = { item: it, status: 'failed', notes: [], deactivated: [] };
    const blocker = blockedBy(it);
    if (blocker) return { result: { ...base, status: 'skipped', message: blocker } };
    try {
      if (it.action !== 'delete') {
        const missing = await missingRefs(it, adapter);
        if (missing.length) {
          const iobj = missing.some((m) => m.startsWith('IOBJ '));
          return {
            result: {
              ...base,
              message: `not written: needs ${missing.join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not exist`,
              hint: iobj
                ? 'A name in a field list is an InfoObject: create it in the same call, or give a field without InfoObject as {name, type, length, label} (bw_describe shows the format).'
                : 'Create it in the same call, or check the name with bw_search.',
            },
          };
        }
      }
      const loc = await adapter.locate(client, it.name, it.sourceSystem);
      const real = loc.name ?? it.name;
      const named = (n: string | undefined) => (n && n !== it.name ? { realName: n } : {});
      let outcome: WriteOutcome;
      if (it.action === 'delete') {
        if (!loc.exists) return { result: { ...base, status: 'unchanged', notes: ['did not exist'] } };
        const bad = outOfBounds(it, loc);
        if (bad) return { result: { ...base, ...named(real), message: `not deleted: ${bad}`, hint: 'Ask the administrator (COBWEB_ALLOWED_*).' } };
        const users = await usersOutsideCall(it, real);
        if (users.length > 0) {
          return {
            result: {
              ...base,
              ...named(real),
              message: `not deleted: used by ${users.slice(0, 6).map((u) => `${u.type} ${u.name}`).join(', ')}${users.length > 6 ? ` and ${users.length - 6} more` : ''}`,
              hint: 'Delete those in the same call, or change them first; bw_context(relation="where_used") lists them.',
            },
          };
        }
        outcome = await adapter.delete(real, itemCtx(it));
      } else if (it.action === 'update' || loc.exists) {
        if (!loc.exists) {
          return { result: { ...base, message: 'does not exist', hint: 'Use action "create".' } };
        }
        const bad = outOfBounds(it, loc);
        if (bad) return { result: { ...base, ...named(real), message: `not changed: ${bad}`, hint: 'Ask the administrator (COBWEB_ALLOWED_*).' } };
        outcome = await adapter.update(real, it.spec ?? {}, itemCtx(it));
        outcome = { ...outcome, name: outcome.name ?? real };
        // Unchanged but not active (e.g. a DTP deactivated by its transformation): activate it.
        if (outcome.status === 'unchanged' && loc.active === false && adapter.activate && !outcome.activation) {
          outcome = { ...outcome, activation: { lockHandle: '' }, notes: [...(outcome.notes ?? []), 'was inactive'] };
        } else if (outcome.status === 'unchanged' && loc.active === false && adapter.activationType && !outcome.activation) {
          const standalone = adapter.activationType === 'dtpa' || adapter.activationType === 'rsds';
          const handle = standalone ? '' : await client.lock(adapter.activationType, real.toLowerCase());
          outcome = { ...outcome, activation: { lockHandle: handle }, notes: [...(outcome.notes ?? []), 'was inactive'] };
        }
        if (it.action === 'create') outcome = { ...outcome, notes: ['already existed', ...(outcome.notes ?? [])] };
      } else {
        const bad = await boundaryProblem(it, adapter);
        if (bad) return { result: { ...base, message: `not created: ${bad}`, hint: 'Ask the administrator (COBWEB_ALLOWED_INFOAREAS).' } };
        outcome = await adapter.create(it.name, it.spec ?? {}, itemCtx(it));
      }
      return {
        result: { ...base, ...named(outcome.name), status: outcome.status, notes: outcome.notes ?? [], activation: outcome.activated ? 'active' : undefined },
        outcome,
      };
    } catch (err) {
      const e = classify(err);
      return { result: { ...base, message: e.message, hint: e.hint } };
    }
  }

  for (const level of levels(items)) {
    const written: { it: WriteItem; outcome: WriteOutcome }[] = [];
    for (const it of level) {
      const { result, outcome } = await writeOne(it);
      results.set(key(it.type, it.name), result);
      if (outcome?.activation && !outcome.activated) written.push({ it, outcome });
    }
    for (const { it, outcome } of written) {
      const result = results.get(key(it.type, it.name))!;
      const adapter = deps.adapters[it.type]!;
      const handle = outcome.activation!.lockHandle;
      const real = result.realName ?? it.name;
      if (input.activate && adapter.activate) {
        try {
          const act = await adapter.activate(client, real, input.transport);
          result.activation = act.ok ? 'active' : 'failed';
          result.deactivated = act.deactivated;
          if (!act.ok) {
            result.message = act.messages.slice(0, 4).join(' / ') || 'activation failed';
            result.hint = outcome.activationHint ?? 'The object is saved but inactive. Fix the cause and call bw_write again, or bw_activate.';
          }
        } catch (err) {
          const e = classify(err);
          result.activation = 'failed';
          result.message = e.message;
          result.hint = e.hint ?? 'The object is saved but inactive.';
        }
        continue;
      }
      if (!input.activate || !adapter.activationType) {
        if (handle && adapter.activationType) await deps.unlock(client, adapter.activationType, real).catch(() => undefined);
        result.activation = 'inactive';
        continue;
      }
      try {
        const act = await deps.activate(client, adapter.activationType, real, handle, input.transport, it.sourceSystem);
        result.activation = act.ok ? 'active' : 'failed';
        result.deactivated = act.deactivated;
        if (!act.ok) {
          result.message = act.messages.slice(0, 4).join(' / ') || 'activation failed';
          result.hint = outcome.activationHint ?? 'The object is saved but inactive. Fix the cause and call bw_write again, or bw_activate.';
        }
      } catch (err) {
        const e = classify(err);
        result.activation = 'failed';
        result.message = e.message;
        result.hint = e.hint ?? 'The object is saved but inactive.';
        if (handle) await deps.unlock(client, adapter.activationType, real).catch(() => undefined);
      }
    }
  }

  const byRank = items.filter((i) => i.action === 'delete').sort((a, b) => RANK[b.type] - RANK[a.type]);
  // Within one call an object goes after the objects that use it, e.g. an InfoObject after the
  // characteristics that carry it as an attribute.
  const deletes: WriteItem[] = [];
  const deleting = new Map(byRank.map((d) => [`${d.type}/${d.name}`, d]));
  const done = new Set<WriteItem>();
  const visit = async (d: WriteItem): Promise<void> => {
    if (done.has(d)) return;
    done.add(d);
    if (deps.whereUsed && CHECK_USAGE.has(d.type)) {
      const users = await usedBy(d.type, d.name, d.sourceSystem).catch(() => []);
      for (const u of users) {
        const first = deleting.get(`${u.type}/${u.name.toUpperCase()}`);
        if (first && first !== d) await visit(first);
      }
    }
    deletes.push(d);
  };
  for (const d of byRank) await visit(d);
  for (const it of deletes) {
    const { result } = await writeOne(it);
    results.set(key(it.type, it.name), result);
  }

  for (const r of results.values()) {
    deps.audit?.({
      tool: 'bw_write',
      action: r.item.action,
      type: r.item.type,
      name: r.realName ?? r.item.name,
      ...(r.item.sourceSystem ? { source_system: r.item.sourceSystem } : {}),
      package: ctx.package,
      ...(ctx.transport ? { transport: ctx.transport } : {}),
      result: r.activation ? `${r.status}, ${r.activation}` : r.status,
      ...(r.message ? { message: r.message.slice(0, 300) } : {}),
    });
  }

  // Objects deactivated by one activation and re-activated later in the same call are fine.
  const reactivated = new Set([...results.values()].filter((r) => r.activation === 'active').map((r) => r.realName ?? r.item.name));
  for (const r of results.values()) r.deactivated = r.deactivated.filter((n) => !reactivated.has(n.toUpperCase()));

  return format(items.map((i) => results.get(key(i.type, i.name))!), ctx, input);
}

function format(results: ItemResult[], ctx: WriteContext, input: WriteInput): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    const label = r.status !== 'failed' && r.activation === 'failed' ? 'activation failed' : r.status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ORDER = ['created', 'changed', 'unchanged', 'deleted', 'activation failed', 'failed', 'skipped'];
  const summary = ORDER.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`).join(', ');
  const head = `${results.length} object${results.length === 1 ? '' : 's'}, package ${ctx.package}${ctx.transport ? `, transport ${ctx.transport}` : ''}: ${summary}`;
  const shown = (r: ItemResult) => `${r.realName ?? r.item.name}${r.item.sourceSystem ? ` (${r.item.sourceSystem})` : ''}`;
  const nameWidth = Math.max(...results.map((r) => shown(r).length));
  const typeWidth = Math.max(4, ...results.map((r) => r.item.type.length));
  const lines = [head];
  for (const r of results) {
    const state =
      r.status === 'failed' || r.status === 'skipped' || r.status === 'deleted'
        ? ''
        : r.activation === 'active'
          ? 'active'
          : r.activation === 'failed'
            ? 'saved, activation failed'
            : r.activation === 'inactive'
              ? `inactive${input.activate ? '' : ' (activate=false)'}`
              : '';
    const identity = r.realName && r.realName !== r.item.name ? r.item.name : '';
    const tail = [state, identity, ...r.notes].filter(Boolean).join(', ');
    lines.push(`${r.status.padEnd(9)} ${r.item.type.padEnd(typeWidth)} ${shown(r).padEnd(nameWidth)}  ${tail}`.trimEnd());
    if (r.message) lines.push(`          ${r.message}`);
    if (r.hint) lines.push(`          hint: ${r.hint}`);
    if (r.deactivated.length > 0) lines.push(`          deactivated by this activation: ${r.deactivated.join(', ')} (re-activate with bw_activate)`);
  }
  return lines.join('\n');
}

/**
 * validate_only: everything a write would check, against BW, without writing. Specs and
 * limits were checked by plan(); here each object is located, the objects it needs must exist
 * (or be created in the same call), targets must be inside the allowed InfoAreas, and deletes
 * must not leave users behind.
 */
async function validate(items: WriteItem[], input: WriteInput, config: Config, client: BwClient, deps: EngineDeps): Promise<string> {
  const inCall = new Set(items.map((i) => key(i.type, i.name)));
  const deleting = new Set(items.filter((i) => i.action === 'delete').map((i) => `${i.type}/${i.name}`));
  const lines: string[] = [];
  let problems = 0;
  const width = Math.max(...items.map((i) => i.name.length + (i.sourceSystem ? i.sourceSystem.length + 3 : 0)));
  const typeWidth = Math.max(4, ...items.map((i) => i.type.length));
  const locateRef = async (type: BwType, name: string): Promise<Location | undefined> => {
    if (type === PROVIDER) {
      for (const t of PROVIDER_TYPES) {
        const r = deps.readers?.[t] ?? deps.adapters[t];
        const loc = r ? await r.locate(client, name).catch(() => undefined) : undefined;
        if (loc?.exists) return loc;
      }
      return { exists: false };
    }
    const reader = deps.readers?.[type] ?? deps.adapters[type];
    return reader ? reader.locate(client, name) : undefined;
  };
  for (const it of [...items].sort((a, b) => RANK[a.type] - RANK[b.type] || a.index - b.index)) {
    const adapter = deps.adapters[it.type]!;
    const issues: string[] = [];
    let verdict: string = it.action;
    try {
      const loc = await adapter.locate(client, it.name, it.sourceSystem);
      const real = loc.name ?? it.name;
      if (it.action === 'create' && loc.exists) verdict = 'update (exists)';
      if (it.action !== 'create' && !loc.exists) {
        if (it.action === 'delete') verdict = 'nothing to delete';
        else issues.push('does not exist');
      }
      if (loc.exists && it.action !== 'create') {
        if (loc.package && !matchesAny(config.allowedPackages, loc.package)) issues.push(`in package ${loc.package}, which is not allowed`);
        if (loc.infoArea && !matchesAny(config.allowedInfoAreas, loc.infoArea)) issues.push(`in InfoArea ${loc.infoArea}, which is not allowed`);
      }
      if (it.action === 'delete' && loc.exists && deps.whereUsed && CHECK_USAGE.has(it.type)) {
        const users = (await deps.whereUsed(client, it.type, real, it.sourceSystem)).filter(
          (u) => !deleting.has(`${u.type}/${u.name.toUpperCase()}`) && !(u.type === it.type && u.name.toUpperCase() === real),
        );
        if (users.length) issues.push(`used by ${users.slice(0, 6).map((u) => `${u.type} ${u.name}`).join(', ')}`);
      }
      if (it.action !== 'delete') {
        for (const ref of adapter.dependsOn(it.action, it.name, it.spec)) {
          if (inCall.has(key(ref.type, ref.name))) continue;
          if (ref.type === 'TRFN' || ref.type === 'DTPA') {
            const found = await locateRef(ref.type, ref.name);
            if (found && !found.exists) issues.push(`needs TRFN ${ref.name}, which does not exist`);
            continue;
          }
          const found = await locateRef(ref.type, ref.name);
          if (found && !found.exists) issues.push(`needs ${ref.type} ${ref.name}, which does not exist`);
        }
        if (!loc.exists) {
          for (const ref of adapter.boundary?.(it.spec ?? {}) ?? []) {
            if (inCall.has(key(ref.type, ref.name))) continue;
            const found = await locateRef(ref.type, ref.name);
            if (found?.infoArea && !matchesAny(config.allowedInfoAreas, found.infoArea)) issues.push(`${ref.type} ${ref.name} is in InfoArea ${found.infoArea}, which is not allowed`);
          }
        }
      }
      const shown = `${real}${it.sourceSystem ? ` (${it.sourceSystem})` : ''}`;
      if (issues.length) problems++;
      lines.push(`${(issues.length ? 'problem' : 'ok').padEnd(8)} ${it.type.padEnd(typeWidth)} ${shown.padEnd(width)}  ${verdict}${issues.length ? `: ${issues.join('; ')}` : ''}`);
    } catch (err) {
      problems++;
      const e = classify(err);
      lines.push(`problem  ${it.type.padEnd(typeWidth)} ${it.name}  ${e.message}`);
    }
  }
  const head = `Validation only, nothing was written. ${items.length} object${items.length === 1 ? '' : 's'}, package ${input.package.toUpperCase()}: ${problems === 0 ? 'no problems found' : `${problems} with problems`}`;
  return [head, ...lines].join('\n');
}
