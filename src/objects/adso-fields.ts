/**
 * ADSO fields without an InfoObject and the properties of single fields (description, field
 * group, aggregation, fixed currency or unit, or the field that holds currency or unit).
 * Works on the document only; adso.ts writes it back with one PUT.
 */
import type { JsonObject } from '../catalog/tools.js';
import { validateArgs } from '../format/validate.js';
import { ToolError } from '../format/errors.js';
import { buildPureFieldElement, resolveFieldGroup, type FieldDef } from '../legacy/adso.js';
import { xmlEscape } from './adapter.js';

export const FIELD_TYPES = ['CHAR', 'NUMC', 'DATS', 'TIMS', 'CUKY', 'UNIT', 'LANG', 'DEC', 'CURR', 'QUAN', 'INT1', 'INT2', 'INT4', 'INT8', 'FLTP', 'STRING', 'SSTRING'];
const AGGREGATIONS = ['SUM', 'MIN', 'MAX', 'NONE'];

/** A field without InfoObject, given as an object in `fields`. */
export const PURE_FIELD: JsonObject = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: FIELD_TYPES },
    length: { type: 'integer', minimum: 1, maximum: 1333 },
    precision: { type: 'integer', minimum: 1, maximum: 34 },
    scale: { type: 'integer', minimum: 0, maximum: 14 },
    label: { type: 'string' },
    aggregation: { type: 'string', enum: AGGREGATIONS },
    group: { type: 'string' },
    currency: { type: 'string' },
    unit: { type: 'string' },
    reference: { type: 'string' },
  },
  required: ['name', 'type'],
  additionalProperties: false,
};

/** Properties of an existing field, in `field_properties`. */
export const FIELD_PROPERTIES: JsonObject = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      field: { type: 'string' },
      label: { type: 'string' },
      group: { type: 'string' },
      aggregation: { type: 'string', enum: AGGREGATIONS },
      currency: { type: 'string' },
      unit: { type: 'string' },
      reference: { type: 'string' },
    },
    required: ['field'],
    additionalProperties: false,
  },
};

export interface FieldProps {
  label?: string;
  group?: string;
  aggregation?: string;
  currency?: string;
  unit?: string;
  reference?: string;
}

export type FieldEntry = string | (FieldProps & { name: string; type: string; length?: number; precision?: number; scale?: number });

/** Field name of an entry in `fields`: an InfoObject name or a field object. */
export function entryName(e: unknown): string {
  return (typeof e === 'string' ? e : String((e as JsonObject)?.name ?? '')).trim().toUpperCase();
}

function checkMoneyRefs(where: string, p: JsonObject, type: string | undefined, errors: string[]): void {
  const refs = ['currency', 'unit', 'reference'].filter((k) => p[k] !== undefined);
  if (refs.length > 1) errors.push(`${where}: give one of currency, unit, reference`);
  if (typeof p.currency === 'string' && !/^[A-Z]{3}$/i.test(p.currency)) errors.push(`${where}.currency: a 3-letter ISO code, e.g. "EUR"`);
  if (type) {
    if (p.currency !== undefined && type !== 'CURR') errors.push(`${where}.currency: only for type CURR`);
    if (p.unit !== undefined && type !== 'QUAN') errors.push(`${where}.unit: only for type QUAN`);
    if (p.reference !== undefined && type !== 'CURR' && type !== 'QUAN') errors.push(`${where}.reference: only for type CURR or QUAN`);
    if ((type === 'CURR' || type === 'QUAN') && refs.length === 0) {
      errors.push(`${where}: type ${type} needs ${type === 'CURR' ? 'currency' : 'unit'} or reference (the ${type === 'CURR' ? 'CUKY' : 'UNIT'} field that holds it)`);
    }
  }
}

/** Strict check of the `fields` entries that are objects. */
export function checkFieldEntries(fields: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(fields)) return;
  fields.forEach((e, i) => {
    const where = `${path}[${i}]`;
    if (typeof e === 'string') return;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${where}: an InfoObject name or a field object {name, type, …}`);
      return;
    }
    const o = e as JsonObject;
    for (const m of validateArgs(PURE_FIELD, o).errors) errors.push(`${where}.${m}`);
    const type = typeof o.type === 'string' ? o.type.toUpperCase() : undefined;
    if (type && ['CHAR', 'NUMC'].includes(type) && o.length === undefined) errors.push(`${where}.length: required for ${type}`);
    if (type === 'DEC' && o.precision === undefined) errors.push(`${where}.precision: required for DEC (total digits)`);
    if ((type === 'CURR' || type === 'QUAN') && (o.scale === undefined || o.scale === 0)) errors.push(`${where}.scale: required for ${type}, decimal places > 0`);
    if (typeof o.name === 'string' && !/^[A-Z][A-Z0-9_]{0,15}$/i.test(o.name)) errors.push(`${where}.name: 1–16 characters A–Z, 0–9, _, starting with a letter`);
    checkMoneyRefs(where, o, type, errors);
  });
}

export function checkFieldProperties(list: unknown, errors: string[]): void {
  if (!Array.isArray(list)) return;
  list.forEach((p, i) => {
    if (p && typeof p === 'object') checkMoneyRefs(`field_properties[${i}]`, p as JsonObject, undefined, errors);
  });
}

function elementRegExp(field: string): RegExp {
  return new RegExp(`[ \\t]*<element\\b[^>]*\\bname="${field}"[^>]*>[\\s\\S]*?<\\/element>`);
}

function setAttr(open: string, attr: string, value: string): string {
  const re = new RegExp(`\\s${attr}="[^"]*"`);
  return re.test(open) ? open.replace(re, ` ${attr}="${value}"`) : open.replace(/^(\s*<element\b)/, `$1 ${attr}="${value}"`);
}

/** Apply properties to one field of the document. Throws for an unknown field. */
export function editField(xml: string, field: string, p: FieldProps, adso: string): { xml: string; changed: string[] } {
  const name = field.toUpperCase();
  const m = elementRegExp(name).exec(xml);
  if (!m) throw new ToolError('validation', `ADSO ${adso} has no field ${name}.`, 'bw_read(type="ADSO", part="fields") lists the fields.');
  const block = m[0];
  const openEnd = block.indexOf('>') + 1;
  let open = block.slice(0, openEnd);
  let body = block.slice(openEnd);
  const changed: string[] = [];
  const attr = (a: string) => open.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];

  if (p.group !== undefined) {
    const value = resolveFieldGroup(xml, p.group, adso);
    if (attr('dimension') !== value) {
      open = setAttr(open, 'dimension', value);
      changed.push(`${name} group`);
    }
  }
  if (p.aggregation !== undefined && attr('infoObjectName') && attr('aggregationBehavior') !== p.aggregation) {
    // BW takes the aggregation of an InfoObject field from the InfoObject and drops a local value.
    throw new ToolError(
      'validation',
      `ADSO ${adso}: the aggregation of ${name} comes from InfoObject ${attr('infoObjectName')}.`,
      'Set aggregation only for fields without InfoObject, or change the InfoObject.',
    );
  }
  if (p.aggregation !== undefined && attr('aggregationBehavior') !== p.aggregation) {
    open = setAttr(open, 'aggregationBehavior', p.aggregation);
    changed.push(`${name} aggregation ${p.aggregation}`);
  }
  if (p.label !== undefined) {
    const tag = `<descriptions label="${xmlEscape(p.label)}"/>`;
    const now = body.match(/<descriptions\b[^>]*\blabel="([^"]*)"/)?.[1];
    if (now !== xmlEscape(p.label)) {
      if (/<descriptions\b[^>]*\/>/.test(body)) body = body.replace(/<descriptions\b[^>]*\/>/, tag);
      else if (/<localProperties\b[^>]*\/>/.test(body)) body = body.replace(/<localProperties\b([^>]*)\/>/, `<localProperties$1>${tag}</localProperties>`);
      else if (/<localProperties\b[^>]*>/.test(body)) body = body.replace(/(<localProperties\b[^>]*>)/, `$1${tag}`);
      else body = body.replace(/(<inlineType\b[^>]*\/>)/, `$1<localProperties xsi:type="BwCore:LocalCharacteristicProperties">${tag}</localProperties>`);
      changed.push(`${name} label`);
    }
  }
  const money = p.currency !== undefined ? 'currency' : p.unit !== undefined ? 'unit' : p.reference !== undefined ? 'reference' : undefined;
  if (money) {
    const wanted =
      money === 'currency'
        ? `<fixedCurrency>${p.currency!.toUpperCase()}</fixedCurrency>`
        : money === 'unit'
          ? `<fixedUnit>${p.unit!.toUpperCase()}</fixedUnit>`
          : `<unitCurrencyElement>#///${p.reference!.toUpperCase()}</unitCurrencyElement>`;
    if (!body.includes(wanted)) {
      body = body.replace(/\s*<(fixedCurrency|fixedUnit|unitCurrencyElement)>[^<]*<\/\1>/g, '');
      body = body.replace(/(<inlineType\b[^>]*\/>)/, `$1${wanted}`);
      changed.push(`${name} ${money}`);
    }
  }
  if (changed.length === 0) return { xml, changed };
  return { xml: xml.slice(0, m.index) + open + body + xml.slice(m.index + block.length), changed };
}

/** The `<element>` of a new field without InfoObject. */
export function pureFieldElement(xml: string, e: Exclude<FieldEntry, string>, adso: string): string {
  const def: FieldDef = {
    name: e.name.toUpperCase(),
    label: xmlEscape(e.label ?? e.name.toUpperCase()),
    dataType: e.type.toUpperCase(),
    length: e.length,
    precision: e.precision,
    scale: e.scale,
    aggregationBehavior: e.aggregation,
  };
  const dimension = e.group ? resolveFieldGroup(xml, e.group, adso) : undefined;
  return dimension ? buildPureFieldElement(def, dimension) : buildPureFieldElement(def);
}
