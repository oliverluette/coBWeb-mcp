/**
 * Argument validation against the tool's own JSON schema (the subset the catalog uses:
 * object, array, string, integer, number, boolean, enum, required, additionalProperties,
 * minItems, maxItems, minimum, maximum, default).
 *
 * The catalog schema is the only definition of a tool's parameters, so what the model sees and
 * what the server accepts cannot drift apart. Unknown parameters are refused with the list of
 * allowed ones, and top-level defaults are filled in.
 */
import type { Json, JsonObject } from '../catalog/tools.js';

export interface ValidationResult {
  value: JsonObject;
  errors: string[];
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

const EXAMPLE: Record<string, string> = { integer: '10', number: '2.5', boolean: 'true' };

/**
 * JSON text of a list or an object, or undefined. Text whose brackets do not balance (a "}" left
 * out before "]" or before ", {", one "]" too few, closers left over at the end) is repaired by
 * closing the open brackets at the point where the text closes an outer one; the result must
 * still pass the schema. "undefined" as a value becomes null.
 */
export function parseJsonText(text: string, expected: 'array' | 'object'): unknown {
  const t = text.trim();
  if (!(expected === 'array' ? t.startsWith('[') : t.startsWith('{'))) return undefined;
  for (const candidate of [t, repairJson(t)]) {
    if (candidate === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeOf(parsed) === expected) return parsed;
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

function repairJson(t: string): string | undefined {
  const close: Record<string, string> = { '{': '}', '[': ']' };
  const stack: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += t[++i] ?? '';
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '{' || c === '[') {
      stack.push(c);
      out += c;
    } else if (c === '}' || c === ']') {
      const open = c === '}' ? '{' : '[';
      if (!stack.includes(open)) {
        if (stack.length === 0 && /^[\s\]}]*$/.test(t.slice(i))) break; // closers left over at the end
        return undefined;
      }
      while (stack[stack.length - 1] !== open) out += close[stack.pop()!];
      stack.pop();
      out += c;
    } else if (c === ',' && stack[stack.length - 1] === '{' && /^\s*[{[]/.test(t.slice(i + 1))) {
      // In an object a value needs a key: ", {" means the object was meant to end before.
      out += close[stack.pop()!] + c;
    } else if (t.startsWith('undefined', i) && /[:,[]\s*$/.test(out)) {
      out += 'null';
      i += 'undefined'.length - 1;
    } else {
      out += c;
    }
  }
  if (inString) return undefined;
  while (stack.length) out += close[stack.pop()!];
  return out;
}

/** An object whose only key is item or items: the wrapper XML-style tool calls put around lists. */
function isWrapper(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (keys[0] === 'item' || keys[0] === 'items');
}

/** A list element in a wrapper of its own ({"item": "BELNR"}) where a single value is expected. */
function unwrapItem(items: JsonObject, v: unknown): unknown {
  if (items.type === 'array' || items.type === 'object') return v;
  let inner = v;
  while (isWrapper(inner)) inner = Object.values(inner as Record<string, unknown>)[0];
  return inner;
}

/** A short example of the expected value, for the error text. */
function exampleOf(schema: JsonObject): string {
  const t = schema.type as string;
  if (EXAMPLE[t]) return EXAMPLE[t];
  if (t === 'array') {
    const items = (schema.items ?? {}) as JsonObject;
    const first = Object.keys((items.properties ?? {}) as JsonObject)[0];
    return items.type === 'object' ? `[{"${first ?? 'name'}": …}]` : '["A", "B"]';
  }
  if (t === 'object') {
    const first = Object.keys((schema.properties ?? {}) as JsonObject)[0];
    return first ? `{"${first}": …}` : '{…}';
  }
  return '';
}

/** The given value, short, for the error text. */
function shown(v: unknown): string {
  const text = typeof v === 'string' ? `"${v}"` : JSON.stringify(v) ?? String(v);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Some models (or their hosts) send numbers and flags as text ("10", "true"). A text that is
 * exactly such a value is taken as that value; the conversion is written into the arguments, so
 * the handler gets the number. Anything else stays and is reported by check().
 */
function coerce(schema: JsonObject | undefined, value: unknown): unknown {
  if (!schema || value === null || value === undefined) return value;
  const expected = schema.type as string | undefined;
  // A list or an object sent as JSON text (some hosts serialize nested arguments): text that
  // parses to the expected shape is taken as such, and the result is converted further.
  if (typeof value === 'string' && (expected === 'array' || expected === 'object')) {
    const parsed = parseJsonText(value, expected);
    return parsed === undefined ? value : coerce(schema, parsed);
  }
  // A list wrapped in an object {"item": …} or {"items": …}, as XML-style tool calls produce it:
  // the content is the list, a single value a list of one; wrappers inside wrappers are removed.
  if (expected === 'array' && isWrapper(value)) {
    let inner: unknown = value;
    while (isWrapper(inner)) inner = Object.values(inner as Record<string, unknown>)[0];
    if (typeof inner === 'string' && inner.trim().startsWith('[')) inner = coerce(schema, inner);
    return coerce(schema, Array.isArray(inner) ? inner : [inner]);
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (expected === 'integer' && /^[+-]?\d+$/.test(t)) return Number(t);
    if (expected === 'number' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (expected === 'boolean' && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    return value;
  }
  if (expected === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  if (Array.isArray(value)) {
    const items = schema.items as JsonObject | undefined;
    if (items) for (let i = 0; i < value.length; i++) value[i] = coerce(items, unwrapItem(items, value[i]));
    return value;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonObject>;
    const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object' ? (schema.additionalProperties as JsonObject) : undefined;
    for (const key of Object.keys(obj)) {
      // An optional property sent as null (or "undefined" in JSON text) is taken as not given.
      if (obj[key] === null) delete obj[key];
      else obj[key] = coerce(props[key] ?? extra, obj[key]);
    }
  }
  return value;
}

function check(schema: JsonObject, value: unknown, path: string, errors: string[]): void {
  const expected = schema.type as string | undefined;
  const actual = typeOf(value);
  if (expected) {
    const ok = expected === actual || (expected === 'number' && actual === 'integer');
    if (!ok) {
      const example = exampleOf(schema);
      const looksJson = actual === 'string' && (expected === 'array' || expected === 'object') && /^\s*[[{]/.test(String(value));
      if (looksJson) {
        let why = '';
        try {
          JSON.parse(String(value));
        } catch (err) {
          why = err instanceof Error ? ` (${err.message})` : '';
        }
        errors.push(`${path}: expected ${expected} (e.g. ${example}), got text that is not valid JSON${why}; send the ${expected} itself, not as text`);
        return;
      }
      errors.push(
        actual === 'string' && EXAMPLE[expected]
          ? `${path}: expected ${expected} (e.g. ${example}, without quotes), got ${shown(value)}`
          : example
            ? `${path}: expected ${expected} (e.g. ${example}), got ${actual} ${shown(value)}`
            : `${path}: expected ${expected}, got ${actual}`,
      );
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as Json)) {
    errors.push(`${path}: "${String(value)}" is not allowed; use one of: ${schema.enum.join(', ')}`);
    return;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} item(s)`);
    const items = schema.items as JsonObject | undefined;
    if (items) value.forEach((v, i) => check(items, v, `${path}[${i}]`, errors));
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonObject>;
    for (const req of (schema.required ?? []) as string[]) {
      if (obj[req] === undefined) errors.push(`${path ? `${path}.` : ''}${req}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = props[key];
      const where = path ? `${path}.${key}` : key;
      if (sub) {
        check(sub, v, where, errors);
      } else if (schema.additionalProperties === false) {
        const allowed = Object.keys(props);
        errors.push(`${where}: unknown parameter${allowed.length ? `; allowed: ${allowed.join(', ')}` : ''}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties as JsonObject, v, where, errors);
      }
    }
  }
}

/** Drop null, undefined and empty-string values: some models send every optional parameter. */
export function normalizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

export function validateArgs(schema: JsonObject, rawArgs: Record<string, unknown> | undefined): ValidationResult {
  if (rawArgs) coerce(schema, rawArgs);
  const args = normalizeArgs(rawArgs);
  const props = (schema.properties ?? {}) as Record<string, JsonObject>;
  const errors: string[] = [];
  check(schema, args, '', errors);
  const value: JsonObject = { ...(args as JsonObject) };
  for (const [key, sub] of Object.entries(props)) {
    if (value[key] === undefined && sub.default !== undefined) value[key] = sub.default;
  }
  return { value, errors };
}
