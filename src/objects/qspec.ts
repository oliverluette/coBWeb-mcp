/**
 * Shared spec parts of the query family: formula text, the selection format, exception
 * aggregation and member properties. Everything here is pure: it checks the spec and turns it
 * into the argument shapes of the document writers in src/legacy/.
 */
import type { JsonObject } from '../catalog/tools.js';
import type { ExceptionAggregation, FilterValue, FormulaNode, KeyFigureRestriction, MemberProperties } from '../legacy/query_update.js';
import { EXCEPTION_AGGREGATION_TYPES, RESULT_AS_VALUES, SINGLE_VALUES_AS_VALUES } from '../legacy/query_update.js';
import type { RkfOperator, RkfRestriction } from '../legacy/rkf_create.js';
import { timeValue } from '../bw/time-values.js';

type Rec = Record<string, unknown>;

// ── Formula text ──────────────────────────────────────────────────────────────

/** Operand counts BW enforces per operator code (min, max). */
const ARITY: Record<string, [number, number]> = {
  '+': [1, 2], '-': [1, 2], '*': [2, 2], '/': [2, 2], '**': [2, 2], DIV: [2, 2], MOD: [2, 2],
  ABS: [1, 1], CEIL: [1, 1], FLOOR: [1, 1], FRAC: [1, 1], TRUNC: [1, 1], SIGN: [1, 1], SQRT: [1, 1],
  EXP: [1, 1], LOG: [1, 1], LOG10: [1, 1], MAX0: [1, 1], MIN0: [1, 1], MAX: [2, 2], MIN: [2, 2],
  '%': [2, 2], '%A': [2, 2], '%_A': [2, 2], '%CT': [1, 1], '%GT': [1, 1], '%RT': [1, 1], '%XT': [1, 1], '%YT': [1, 1],
  COUNT: [1, 1], DELTA: [1, 1], NDIV0: [1, 1], NODIM: [1, 1], NOERR: [1, 1], FIX: [1, 1], DATE: [1, 1], TIME: [1, 1],
  CMR: [1, 1], SUMCT: [1, 1], SUMGT: [1, 1], SUMRT: [1, 1], SUMXT: [1, 1], SUMYT: [1, 1],
  SIN: [1, 1], COS: [1, 1], TAN: [1, 1], SINH: [1, 1], COSH: [1, 1], TANH: [1, 1], ASIN: [1, 1], ACOS: [1, 1], ATAN: [1, 1],
  NOT: [1, 1], AND: [2, 2], OR: [2, 2], XOR: [2, 2],
  '<': [2, 2], '<=': [2, 2], '<>': [2, 2], '==': [2, 2], '>': [2, 2], '>=': [2, 2], IF: [3, 3],
};

/** Where a formula is used decides which operands it may have. */
export type FormulaContext = 'ckf' | 'query' | 'cell';

interface Tok {
  kind: 'num' | 'str' | 'name' | 'op' | '(' | ')' | ',';
  text: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j++];
      }
      if (j >= src.length) throw new Error(`formula: unclosed quote at ${start + 1}`);
      out.push({ kind: 'str', text, pos: start });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      // A name of a CompositeProvider field starts with a digit too ("4ZPROV-FIELD").
      const m = /^[0-9][0-9A-Za-z_/]*(?:-[A-Za-z_][0-9A-Za-z_/]*)?/.exec(src.slice(i));
      const numeric = /^(?:[0-9]+(?:\.[0-9]*)?)(?:[eE][+-]?[0-9]+)?(?![0-9A-Za-z_/])/.test(src.slice(i));
      if (m && !numeric && /[A-Za-z_]/.test(m[0])) {
        out.push({ kind: 'name', text: m[0], pos: start });
        i += m[0].length;
        continue;
      }
      const n = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!n) throw new Error(`formula: unexpected "${c}" at ${start + 1}`);
      out.push({ kind: 'num', text: n[0], pos: start });
      i += n[0].length;
      continue;
    }
    // A name may carry a namespace ("/BIC/ZAMOUNT"); a lone "/" is the division.
    if (/[A-Za-z_]/.test(c) || (c === '/' && /^\/[A-Za-z0-9]+\/[0-9A-Za-z_]/.test(src.slice(i)))) {
      const m = /^(?:\/[A-Za-z0-9]+\/)?[A-Za-z_0-9][0-9A-Za-z_]*(?::(?:"[^"]*"|'[^']*'|[0-9A-Za-z_/-]+))?/.exec(src.slice(i))!;
      out.push({ kind: 'name', text: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if (c === '%') {
      const m = /^%[A-Z_]*/.exec(src.slice(i))!;
      out.push({ kind: 'name', text: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['**', '<=', '>=', '<>', '=='].includes(two)) {
      out.push({ kind: src[i + 2] === '(' || two !== '**' ? 'name' : 'op', text: two, pos: start });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>') {
      out.push({ kind: 'name', text: c, pos: start });
      i++;
      continue;
    }
    if ('+-*/'.includes(c)) {
      out.push({ kind: 'op', text: c, pos: start });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ kind: c, text: c, pos: start });
      i++;
      continue;
    }
    throw new Error(`formula: unexpected "${c}" at ${start + 1}`);
  }
  // "**" is an infix operator unless used as a function name.
  return out.map((t) => (t.text === '**' && t.kind === 'name' ? { ...t, kind: 'op' as const } : t));
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, '');

/**
 * Parse formula text into the node tree the document writers take.
 *
 * NAME = basic key figure; ckf:NAME / rkf:NAME = reusable component; var:NAME = formula
 * variable; "text" = another member of the structure (query); cell:"text" = a cell.
 */
export function parseFormula(src: string, context: FormulaContext): FormulaNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const fail = (msg: string, t = peek()): never => {
    throw new Error(`formula: ${msg}${t ? ` at ${t.pos + 1} ("${t.text}")` : ' at the end'}`);
  };
  const expect = (kind: Tok['kind']) => (peek()?.kind === kind ? toks[p++] : fail(`"${kind}" expected`));
  const op = (code: string, operands: FormulaNode[]): FormulaNode => ({ type: 'operator', code, operands });

  function expr(): FormulaNode {
    let left = term();
    while (peek()?.kind === 'op' && (peek().text === '+' || peek().text === '-')) {
      const code = toks[p++].text;
      left = op(code, [left, term()]);
    }
    return left;
  }
  function term(): FormulaNode {
    let left = power();
    while (peek()?.kind === 'op' && (peek().text === '*' || peek().text === '/')) {
      const code = toks[p++].text;
      left = op(code, [left, power()]);
    }
    return left;
  }
  function power(): FormulaNode {
    const base = unary();
    if (peek()?.kind === 'op' && peek().text === '**') {
      p++;
      return op('**', [base, unary()]);
    }
    return base;
  }
  function unary(): FormulaNode {
    if (peek()?.kind === 'op' && peek().text === '-') {
      p++;
      return op('-', [unary()]);
    }
    if (peek()?.kind === 'op' && peek().text === '+') {
      p++;
      return unary();
    }
    return atom();
  }
  function atom(): FormulaNode {
    const t = peek() ?? fail('operand expected');
    if (t.kind === 'num') {
      p++;
      return { type: 'constant', value: t.text };
    }
    if (t.kind === 'str') {
      p++;
      if (context === 'ckf') fail('a member text is only possible in a query formula', t);
      return context === 'cell' ? { type: 'cell', cell: t.text } : { type: 'member', description: t.text };
    }
    if (t.kind === '(') {
      p++;
      const inner = expr();
      expect(')');
      return inner;
    }
    if (t.kind === 'name') {
      p++;
      if (peek()?.kind === '(') {
        const code = t.text.toUpperCase();
        const arity = ARITY[code] ?? fail(`unknown function ${code}`, t);
        p++;
        const args: FormulaNode[] = [];
        if (peek()?.kind !== ')') {
          args.push(expr());
          while (peek()?.kind === ',') {
            p++;
            args.push(expr());
          }
        }
        expect(')');
        if (args.length < arity[0] || args.length > arity[1]) {
          fail(`${code} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} operand${arity[1] === 1 ? '' : 's'}, not ${args.length}`, t);
        }
        return op(code, args);
      }
      const colon = t.text.indexOf(':');
      if (colon > 0) {
        const prefix = t.text.slice(0, colon).toLowerCase();
        const value = unquote(t.text.slice(colon + 1));
        if (prefix === 'ckf' || prefix === 'rkf') return { type: 'component', component_name: value.toUpperCase() };
        if (prefix === 'var') return { type: 'variable', variable_name: value.toUpperCase() };
        if (prefix === 'cell') {
          if (context !== 'cell') fail('cell: is only possible in a cell formula', t);
          return { type: 'cell', cell: value };
        }
        if (prefix === 'member') {
          if (context === 'ckf') fail('a member is only possible in a query formula', t);
          return { type: 'member', description: value };
        }
        fail(`unknown prefix ${prefix}: (use ckf:, rkf:, var:, member: or cell:)`, t);
      }
      if (context === 'cell') fail('a cell formula refers to cells: "text" or cell:"text"', t);
      return { type: 'key_figure', name: t.text.toUpperCase() };
    }
    return fail('operand expected', t);
  }

  if (toks.length === 0) throw new Error('formula: empty');
  const tree = expr();
  if (p < toks.length) fail('unexpected');
  return tree;
}

/** A formula given as text or, as the old tools took it, as a node tree. */
export function formulaOf(v: unknown, context: FormulaContext): FormulaNode {
  if (typeof v === 'string') return parseFormula(v, context);
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as FormulaNode;
  throw new Error('formula: text or a node tree');
}

const INFIX = new Set(['+', '-', '*', '/', '**']);
const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '**': 3 };

/** Render a node tree in the formula text notation (inverse of parseFormula). */
export function formulaText(node: FormulaNode | null | undefined, parentPrec = 0): string {
  if (!node) return '';
  const n = node as Rec;
  switch (n['type']) {
    case 'constant':
      return String(n['value'] ?? '');
    case 'key_figure':
      return String(n['name'] ?? '');
    case 'variable':
      return `var:${n['variable_name']}`;
    case 'component':
      return `${String(n['component_type'] ?? 'ckf').toLowerCase()}:${n['component_name'] ?? n['component_id'] ?? '?'}`;
    case 'member':
      return JSON.stringify(String(n['description'] ?? n['member_id'] ?? ''));
    case 'cell':
      return `cell:${JSON.stringify(String(n['cell'] ?? ''))}`;
    case 'operator': {
      const code = String(n['code']);
      const ops = ((n['operands'] as FormulaNode[]) ?? []).map((o) => o);
      if (INFIX.has(code) && ops.length === 2) {
        const prec = PREC[code];
        const text = `${formulaText(ops[0], prec)} ${code} ${formulaText(ops[1], prec + (code === '-' || code === '/' ? 1 : 0))}`;
        return prec < parentPrec ? `(${text})` : text;
      }
      if (code === '-' && ops.length === 1) return `-${formulaText(ops[0], 4)}`;
      return `${code}(${ops.map((o) => formulaText(o)).join(', ')})`;
    }
    default:
      return JSON.stringify(n);
  }
}

// ── Selection format ──────────────────────────────────────────────────────────

export const SELECTION: JsonObject = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    values: { type: 'array', items: { type: 'string' } },
    exclude: { type: 'boolean' },
    selections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['eq', 'ne', 'between', 'gt', 'ge', 'lt', 'le', 'pattern'] },
          low: { type: 'string' },
          high: { type: 'string' },
          exclude: { type: 'boolean' },
        },
        required: ['low'],
        additionalProperties: false,
      },
    },
    variable: { type: 'string' },
  },
  required: ['field'],
  additionalProperties: false,
};

export interface Sel {
  op: string;
  low: string;
  high?: string;
  exclude: boolean;
}

/** The selections of one entry of the selection format, normalized. */
export function selectionsOf(entry: Rec): Sel[] {
  if (Array.isArray(entry['values'])) {
    const exclude = entry['exclude'] === true;
    return (entry['values'] as unknown[]).map((v) => ({ op: 'eq', low: String(v), exclude }));
  }
  return ((entry['selections'] as Rec[] | undefined) ?? []).map((s) => {
    let op = String(s['op'] ?? 'eq');
    let exclude = s['exclude'] === true;
    if (op === 'ne') {
      op = 'eq';
      exclude = !exclude;
    }
    return { op, low: String(s['low'] ?? ''), ...(s['high'] !== undefined ? { high: String(s['high']) } : {}), exclude };
  });
}

/** Spec check for a list in the selection format; `ops` are the operators the target stores. */
export function checkSelections(list: unknown, path: string, ops: readonly string[], errors: string[], allowVariable = false): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) return void errors.push(`${path}: a list of {field, values | selections${allowVariable ? ' | variable' : ''}}`);
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const e = (raw ?? {}) as Rec;
    const at = `${path}[${i}]`;
    if (typeof e['field'] !== 'string' || !e['field']) return void errors.push(`${at}.field: required`);
    const field = String(e['field']).toUpperCase();
    if (seen.has(field)) errors.push(`${at}: ${field} is listed twice`);
    seen.add(field);
    const forms = ['values', 'selections', 'variable'].filter((k) => e[k] !== undefined);
    if (forms.length !== 1) return void errors.push(`${at}: give exactly one of values, selections${allowVariable ? ', variable' : ''}`);
    if (e['variable'] !== undefined && !allowVariable) errors.push(`${at}.variable: not possible here`);
    if (e['exclude'] !== undefined && e['values'] === undefined) errors.push(`${at}.exclude: belongs to values; selections carry their own`);
    for (const s of selectionsOf(e)) {
      const shown = s.op === 'eq' && s.exclude && e['selections'] ? 'ne' : s.op;
      if (!ops.includes(s.op)) errors.push(`${at}: operator ${shown} cannot be stored here (possible: ${ops.join(', ')})`);
      if (s.op === 'between' && s.high === undefined) errors.push(`${at}: between needs high`);
      if (s.op !== 'between' && s.high !== undefined) errors.push(`${at}: high only with between`);
    }
  });
}

/** Operators a query filter and a member restriction store. */
export const QUERY_OPS = ['eq', 'between'] as const;
/** Operators a restricted key figure stores. */
export const RKF_OPS = ['eq', 'between', 'gt', 'ge', 'lt', 'le', 'pattern'] as const;

/** Values of a query filter or member restriction. */
export function filterValuesOf(entry: Rec): FilterValue[] {
  const field = String(entry['field'] ?? '');
  // Standard time characteristics: internal key computed, the display form as value.
  const side = (v: string, key: 'value' | 'high') => {
    const t = timeValue(field, v);
    return t ? { [key]: t.desc, [key === 'value' ? 'internal_value' : 'high_internal_value']: t.intKey } : { [key]: v };
  };
  return selectionsOf(entry).map((s) => ({
    ...(side(s.low, 'value') as { value: string }),
    ...(s.high !== undefined ? side(s.high, 'high') : {}),
    ...(s.exclude ? { exclude: true } : {}),
  }));
}

export function restrictionsOf(list: unknown): KeyFigureRestriction[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as Rec[]).map((e) => ({ infoobject: String(e['field']).toUpperCase(), values: filterValuesOf(e) }));
}

const RKF_OPERATOR: Record<string, RkfOperator> = {
  eq: 'Equal', between: 'Between', gt: 'GreaterThan', ge: 'GreaterEqual', lt: 'LessThan', le: 'LessEqual', pattern: 'Contains',
};

/** RKF restrictions: one group per characteristic, operator and include/exclude. */
export function rkfRestrictionsOf(list: unknown): RkfRestriction[] {
  const out: RkfRestriction[] = [];
  for (const e of (Array.isArray(list) ? list : []) as Rec[]) {
    const field = String(e['field']).toUpperCase();
    const groups = new Map<string, RkfRestriction>();
    for (const s of selectionsOf(e)) {
      const key = `${s.op}/${s.exclude}`;
      let g = groups.get(key);
      if (!g) {
        g = { characteristic: field, operator: RKF_OPERATOR[s.op], values: [], ...(s.exclude ? { exclude: true } : {}) };
        groups.set(key, g);
        out.push(g);
      }
      g.values.push({ low: s.low, ...(s.high !== undefined ? { high: s.high } : {}) });
    }
  }
  return out;
}

// ── Exception aggregation and member properties ──────────────────────────────

export const EXCEPTION_AGGREGATION: JsonObject = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...EXCEPTION_AGGREGATION_TYPES] },
    over: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    all_others: { type: 'boolean' },
  },
  required: ['type'],
  additionalProperties: false,
};

/** {type, over, all_others} → the writers' shape; false → back to standard aggregation. */
export function exceptionAggregationOf(v: unknown): ExceptionAggregation | false | undefined {
  if (v === undefined) return undefined;
  if (v === false || v === null) return false;
  const e = v as Rec;
  const over = Array.isArray(e['over']) ? (e['over'] as unknown[]).map((x) => String(x).toUpperCase()) : [];
  return {
    type: String(e['type']).toUpperCase(),
    ...(over.length > 1 ? { reference_characteristics: over } : over.length === 1 ? { reference_characteristic: over[0] } : {}),
    ...(e['all_others'] === true ? { exclude: true } : {}),
  };
}

export const MEMBER_PROPERTIES: Record<string, JsonObject> = {
  description: { type: 'string' },
  decimals: { type: 'integer', minimum: 0, maximum: 9 },
  scaling: {},
  visibility: { type: 'string', enum: ['hide', 'always', 'never', 'default'] },
  sign_inversion: { type: 'boolean' },
  input_ready: {},
  disaggregation: { type: 'string', enum: ['copy', 'no', 'absolute', 'default'] },
  disaggregation_reference: { type: 'string' },
  constant_selection: { type: 'boolean' },
  calculation: {},
  exception_aggregation: {},
};

export function checkMemberProperties(p: Rec, at: string, errors: string[]): void {
  if (p['scaling'] !== undefined && p['scaling'] !== false && !(Number.isInteger(p['scaling']) && (p['scaling'] as number) >= 0 && (p['scaling'] as number) <= 9)) {
    errors.push(`${at}.scaling: 0 to 9 (power of ten), or false`);
  }
  if (p['input_ready'] !== undefined && typeof p['input_ready'] !== 'boolean' && p['input_ready'] !== 'default') errors.push(`${at}.input_ready: true, false or "default"`);
  const c = p['calculation'];
  if (c !== undefined && c !== false) {
    if (!c || typeof c !== 'object') errors.push(`${at}.calculation: {results_as, single_values_as, apply_to_result, cumulation} or false`);
    else {
      const calc = c as Rec;
      for (const k of Object.keys(calc)) if (!['results_as', 'single_values_as', 'apply_to_result', 'cumulation'].includes(k)) errors.push(`${at}.calculation.${k}: unknown`);
      if (calc['results_as'] !== undefined && !(RESULT_AS_VALUES as readonly string[]).includes(String(calc['results_as']))) errors.push(`${at}.calculation.results_as: one of ${RESULT_AS_VALUES.join(', ')}`);
      if (calc['single_values_as'] !== undefined && !(SINGLE_VALUES_AS_VALUES as readonly string[]).includes(String(calc['single_values_as']))) errors.push(`${at}.calculation.single_values_as: one of ${SINGLE_VALUES_AS_VALUES.join(', ')}`);
    }
  }
  const ea = p['exception_aggregation'];
  if (ea !== undefined && ea !== false) {
    const e = (ea ?? {}) as Rec;
    if (!(EXCEPTION_AGGREGATION_TYPES as readonly string[]).includes(String(e['type']).toUpperCase())) errors.push(`${at}.exception_aggregation.type: one of ${EXCEPTION_AGGREGATION_TYPES.join(', ')}`);
  }
}

const VISIBILITY: Record<string, MemberProperties['hidden']> = { hide: 'hide', always: 'showAlways', never: 'showNever', default: false };

/** coBWeb member properties → the writers' MemberProperties; undefined when none is given. */
export function memberPropertiesOf(p: Rec): MemberProperties | undefined {
  const out: MemberProperties = {};
  if (typeof p['description'] === 'string') out.description = p['description'];
  if (typeof p['decimals'] === 'number') out.decimals = p['decimals'];
  if (p['scaling'] !== undefined) out.scaling = p['scaling'] as number | false;
  if (typeof p['visibility'] === 'string') out.hidden = VISIBILITY[p['visibility']];
  if (typeof p['sign_inversion'] === 'boolean') out.sign_inversion = p['sign_inversion'];
  if (p['input_ready'] !== undefined) out.input_mode = p['input_ready'] === true ? 'inputReady' : p['input_ready'] === false ? 'not' : false;
  if (typeof p['disaggregation'] === 'string') out.disaggregation = p['disaggregation'] === 'default' ? false : (p['disaggregation'] as 'copy' | 'no' | 'absolute');
  if (typeof p['disaggregation_reference'] === 'string') out.disaggregation_reference = p['disaggregation_reference'];
  if (typeof p['constant_selection'] === 'boolean') out.constant_selection = p['constant_selection'];
  if (p['calculation'] !== undefined) {
    const c = p['calculation'];
    out.calculation =
      c === false
        ? false
        : {
            ...((c as Rec)['results_as'] !== undefined ? { result_as: String((c as Rec)['results_as']) } : {}),
            ...((c as Rec)['single_values_as'] !== undefined ? { single_values_as: String((c as Rec)['single_values_as']) } : {}),
            ...((c as Rec)['apply_to_result'] !== undefined ? { apply_to_result: (c as Rec)['apply_to_result'] === true } : {}),
            ...((c as Rec)['cumulation'] !== undefined ? { cumulation: (c as Rec)['cumulation'] === true } : {}),
          };
  }
  const ea = exceptionAggregationOf(p['exception_aggregation']);
  if (ea !== undefined) out.exception_aggregation = ea;
  return Object.keys(out).length ? out : undefined;
}
