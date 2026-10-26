// Based on bw-modeling-mcp (https://github.com/dnic-dev/bw-modeling-mcp),
// Copyright (c) 2026 dnic-dev, MIT License (see NOTICE).
// Kept close to the original on purpose: these are the proven write paths of the BW modeling API.
// Changes for coBWeb are marked "coBWeb:". The object adapters in src/objects/ call into this module.

import { BwClient, createClientFromEnv, bwSeg, lockSessionHeader, resolveMasterSystem } from '../bw/client.js';
import { logonUser as resolveLogonUser } from '../bw/logon-user.js'; // coBWeb
import { queryTable } from './metadata_sql.js';
import {
  QUERY_ACCEPT_LIST,
  queryWriteMediaType,
  variableAccept,
  variableWriteMediaType,
} from './query.js';

export const FORMULA_DIMENSIONS = ['Number', 'Amount', 'Quantity', 'Price', 'Quota', 'Date', 'Time'] as const;
export type FormulaDimension = (typeof FORMULA_DIMENSIONS)[number];

/** Pseudo InfoObject every formula variable is defined on. */
export const FORMULA_IOBJ = '1FORMULA';

/** Pseudo InfoObject of a text variable that is not replaced from a characteristic. */
export const TEXT_IOBJ = '1TEXT';

export const TEXT_REPLACEMENT_TYPES = ['Key', 'ExternalCharacteristic', 'Name'] as const;
export const TEXT_REPLACEMENT_INTERVALS = ['FromValue', 'ToValue', 'Difference'] as const;

export interface CreateVariableArgs {
  variable_name: string;
  iobj_name?: string;
  description: string;
  development_class?: string;
  ready_for_input?: boolean;
  reusable?: boolean;
  represents?: 'Interval' | 'SingleValue' | 'SeveralSingleValues' | 'SelectionOption';
  processing_type?: 'UserEntry' | 'CustomerExit' | 'Authorization' | 'ReplacementPath';
  variable_type?: 'CharacteristicValue' | 'Hierarchy' | 'HierarchyNodes' | 'Formula' | 'Text';
  input_type?: 'Optional' | 'MandatoryWithInitial' | 'MandatoryWithoutInitial';
  /** Formula variables only: what the value stands for. */
  dimension?: FormulaDimension;
  /** Formula variables only: the value proposed on the variable screen. */
  default_value?: number;
  /** Formula variables of dimension Amount or Price: the currency key. */
  currency?: string;
  /** Formula variables of dimension Quantity or Price: the unit of measure. */
  unit?: string;
  /** Text variables by replacement path: what of the characteristic value the text shows. */
  replacement_type?: (typeof TEXT_REPLACEMENT_TYPES)[number];
  /** Text variables by replacement path: which bound of the value is shown. */
  replacement_interval?: (typeof TEXT_REPLACEMENT_INTERVALS)[number];
  /** Text variables by replacement path: first character shown, counted from 0. */
  offset_start?: number;
  /** Text variables by replacement path: number of characters shown; 0 shows the rest. */
  offset_length?: number;
  /** Text variables by replacement path: a characteristic variable on the same characteristic to read the value from. */
  replacement_variable?: string;
  master_language?: string;
  package?: string;
  transport?: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Case-insensitive header lookup (axios lowercases response header names). */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Parse the atom feed the create POST returns. Every entry carries a messageType
 * and an atom:title. A messageType of "Error" is a failure (thrown); Information
 * and Warning entries are collected and returned.
 */
function parseCheckResult(body: string, what: string): string[] {
  const messages: string[] = [];
  const errorTitles: string[] = [];
  const entryRegex = /<atom:entry>([\s\S]*?)<\/atom:entry>/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(body)) !== null) {
    const entry = entryMatch[1];
    const messageType = entry.match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = entry.match(/<atom:title>([\s\S]*?)<\/atom:title>/)?.[1]?.trim() ?? '';
    if (messageType === 'Error') {
      errorTitles.push(title || '(no title)');
    } else if (title) {
      messages.push(`${messageType || 'Message'}: ${title}`);
    }
  }
  if (errorTitles.length > 0) {
    throw new Error(`${what} failed:\n${errorTitles.join('\n')}`);
  }
  return messages;
}

/** Decimal separator of a USR01-DCPFM setting: "X" is 1,234,567.89, blank and "Y" use a comma. */
export function decimalSeparatorOf(dcpfm: string): '.' | ',' {
  return dcpfm.trim().toUpperCase() === 'X' ? '.' : ',';
}

/**
 * The decimal notation of the logon user, or undefined when it cannot be read.
 *
 * A formula variable's default value is parsed in this notation on every write and shown in
 * it on every read; the `internalValue` attribute is ignored. With a comma notation "2.5"
 * is stored as 25 and still reported as consistent, so a fractional value must never be
 * sent without knowing it. `@sy-uname` makes the lookup work under principal propagation,
 * where the server has no configured user name.
 */
export async function userDecimalSeparator(client: BwClient): Promise<'.' | ',' | undefined> {
  try {
    const rows = await queryTable(client, 'SELECT bname, dcpfm FROM usr01 WHERE bname = @sy-uname', 1);
    return rows.length ? decimalSeparatorOf(rows[0].DCPFM ?? '') : undefined;
  } catch {
    return undefined;
  }
}

/** Render a number in the user's notation, without thousands separators. */
export function formatDecimal(value: number, separator: '.' | ','): string {
  if (!Number.isFinite(value)) throw new Error('default_value must be a finite number.');
  let text = String(value);
  if (/e/i.test(text)) text = value.toFixed(10).replace(/\.?0+$/, '');
  return separator === ',' ? text.replace('.', ',') : text;
}

/** Parse a value BW shows in the user's notation ("-3,75000", "2.50000", "1.234,5") back to a number. */
export function parseDecimal(text: string, separator: '.' | ','): number | undefined {
  let t = text.trim().replace(/\s/g, '');
  if (!t) return undefined;
  if (t.endsWith('-')) t = '-' + t.slice(0, -1);
  const thousands = separator === ',' ? '.' : ',';
  t = t.split(thousands).join('');
  if (separator === ',') t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** The default value as the backend must receive it, refusing a fraction it would misread. */
export async function formulaDefaultLiteral(client: BwClient, value: number): Promise<string> {
  if (Number.isInteger(value)) return formatDecimal(value, '.');
  const separator = await userDecimalSeparator(client);
  if (!separator) {
    throw new Error(
      'The decimal notation of the logon user could not be read (USR01 through ADT DataPreview), and ' +
        'BW parses a fractional default value in that notation — with the wrong separator 2.5 is ' +
        'stored as 25. Only whole-number defaults can be set without it.'
    );
  }
  return formatDecimal(value, separator);
}

export function defaultSelectionXml(iobjName: string, value?: string): string {
  if (value === undefined) {
    return `<Qry:selections infoObject="${iobjName}" paramSelectionType="Default" usageType="asFilter"/>`;
  }
  const v = escapeXml(value);
  return `<Qry:selections infoObject="${iobjName}" paramSelectionType="Default" usageType="asFilter">` +
    `<Qry:tokens xsi:type="Qry:SelectionRange" usageType="asFilter" operator="Equal">` +
    `<Qry:fromValue internalValue="${v}"><Qry:type>Value</Qry:type><Qry:value>${v}</Qry:value></Qry:fromValue>` +
    `</Qry:tokens></Qry:selections>`;
}

/**
 * Currency and unit of a formula variable, as `key` attributes (RSZGLOBV-WAERS / MEEHT).
 * A text body in these elements is dropped without a message.
 */
export function unitCurrencyXml(currency?: string, unit?: string): string {
  const el = (tag: string, key?: string) =>
    key ? `<Qry:${tag} key="${escapeXml(key.toUpperCase())}"/>` : `<Qry:${tag}/>`;
  return el('currency', currency) + el('unit', unit);
}

/**
 * Which of currency and unit a dimension takes. A Quantity variable without a unit (and an
 * Amount variable without a currency) saves as consistent, but every query that computes with
 * it fails to generate; a Price takes either or both.
 */
export function checkUnitCurrency(dimension: string, currency?: string, unit?: string): void {
  const takesCurrency = dimension === 'Amount' || dimension === 'Price';
  const takesUnit = dimension === 'Quantity' || dimension === 'Price';
  if (currency && !takesCurrency) throw new Error(`A formula variable of dimension ${dimension} has no currency.`);
  if (unit && !takesUnit) throw new Error(`A formula variable of dimension ${dimension} has no unit.`);
  if (dimension === 'Amount' && !currency) {
    throw new Error('A formula variable of dimension Amount needs a currency: a query cannot be generated without it.');
  }
  if (dimension === 'Quantity' && !unit) {
    throw new Error('A formula variable of dimension Quantity needs a unit: a query cannot be generated without it.');
  }
}

const FORMULA_FIELDS = ['dimension', 'default_value', 'currency', 'unit'] as const;
const TEXT_FIELDS = ['replacement_type', 'replacement_interval', 'offset_start', 'offset_length', 'replacement_variable'] as const;

function refuseFields(args: CreateVariableArgs, fields: readonly (keyof CreateVariableArgs)[], owner: string): void {
  for (const field of fields) {
    if (args[field] !== undefined) throw new Error(`${field} applies to ${owner}.`);
  }
}

function validateCharacteristicArgs(args: CreateVariableArgs): void {
  if (!args.iobj_name) throw new Error('iobj_name is required for a characteristic variable.');
  refuseFields(args, FORMULA_FIELDS, 'formula variables only (variable_type "Formula")');
  refuseFields(args, TEXT_FIELDS, 'text variables only (variable_type "Text")');
}

/** The processing type of a text variable: by replacement path when it names a characteristic. */
export function textProcType(args: CreateVariableArgs): string {
  return args.processing_type ?? (args.iobj_name ? 'ReplacementPath' : 'UserEntry');
}

export function validateTextArgs(args: CreateVariableArgs): void {
  refuseFields(args, FORMULA_FIELDS, 'formula variables only (variable_type "Formula")');
  const procType = textProcType(args);
  if (procType !== 'ReplacementPath' && procType !== 'CustomerExit' && procType !== 'UserEntry') {
    throw new Error(`A text variable is filled by "ReplacementPath", "CustomerExit" or "UserEntry", not "${procType}".`);
  }
  if (args.represents && args.represents !== 'SingleValue') {
    throw new Error('A text variable always represents a single value.');
  }
  if (procType === 'ReplacementPath') {
    if (!args.iobj_name) throw new Error('A text variable by replacement path needs iobj_name: the characteristic whose value it shows.');
    // Saved as consistent, but the query generator then refuses every query using it.
    if (args.ready_for_input) throw new Error('A text variable by replacement path cannot be ready for input.');
    if (args.replacement_type && !(TEXT_REPLACEMENT_TYPES as readonly string[]).includes(args.replacement_type)) {
      throw new Error(`replacement_type must be one of ${TEXT_REPLACEMENT_TYPES.join(', ')}.`);
    }
    if (args.replacement_interval && !(TEXT_REPLACEMENT_INTERVALS as readonly string[]).includes(args.replacement_interval)) {
      throw new Error(`replacement_interval must be one of ${TEXT_REPLACEMENT_INTERVALS.join(', ')}.`);
    }
    for (const field of ['offset_start', 'offset_length'] as const) {
      const v = args[field];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 9999)) throw new Error(`${field} must be a whole number from 0 to 9999.`);
    }
  } else {
    if (args.iobj_name && args.iobj_name.toUpperCase() !== TEXT_IOBJ) {
      throw new Error(`A text variable filled by ${procType} is not defined on a characteristic: leave iobj_name out.`);
    }
    refuseFields(args, TEXT_FIELDS, 'text variables by replacement path only');
  }
}

export interface SourceVariable {
  id: string;
  name: string;
  description: string;
}

/**
 * The replacement path of a text variable, as the backend stores it (RSZGLOBV FLAGR, FLAGLH,
 * FOFFSET, FLENGTH). A source variable goes on the same element as its id, name and
 * description (REFERENCE_UID), as the modeling tools write it.
 */
export function textReplacementPathXml(args: CreateVariableArgs, source?: SourceVariable): string {
  const pad = (n?: number) => String(n ?? 0).padStart(4, '0');
  const from = source
    ? ` id="${escapeXml(source.id)}" name="${escapeXml(source.name)}" description="${escapeXml(source.description)}"`
    : '';
  return `<Qry:replacementPath type="${args.replacement_type ?? 'Key'}" asBoolean="false"` +
    ` offsetStart="${pad(args.offset_start)}" offsetLength="${pad(args.offset_length)}"` +
    ` calculateBeforeNonCum="false" interval="${args.replacement_interval ?? 'FromValue'}"${from}/>`;
}

/** The characteristic variable a text variable reads its value from; it must sit on the same characteristic. */
async function resolveSourceVariable(client: BwClient, name: string, iobjName: string): Promise<SourceVariable> {
  const nameUpper = name.toUpperCase();
  const exist = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${name.toLowerCase()}&type=VAR`,
    { 'bwmt-level': '50' }
  );
  if (header(exist.headers, 'compexist') !== 'true') throw new Error(`Variable '${nameUpper}' does not exist.`);
  const { body } = await client.get(`/sap/bw/modeling/variable/${bwSeg(name.toLowerCase())}/a`, variableAccept());
  const open = body.match(/<Qry:mainComponent\b[^>]*>/)?.[0] ?? '';
  const id = open.match(/\bid="([^"]+)"/)?.[1] ?? header(exist.headers, 'elemuid');
  const iobj = open.match(/\binfoObject="([^"]+)"/)?.[1] ?? '';
  const type = body.match(/<Qry:type>([^<]*)<\/Qry:type>\s*<Qry:procType>/)?.[1] ?? '';
  if (!id) throw new Error(`Variable '${nameUpper}' has no id.`);
  if (type && type !== 'CharacteristicValue') {
    throw new Error(`Variable '${nameUpper}' is a ${type} variable; a text variable reads its value from a characteristic value variable.`);
  }
  if (iobj.toUpperCase() !== iobjName) {
    throw new Error(`Variable '${nameUpper}' is on ${iobj || 'no characteristic'}, not on ${iobjName}.`);
  }
  const description = body.match(/<Qry:description\b[^>]*\bvalue="([^"]*)"/)?.[1] ?? '';
  return { id, name: nameUpper, description: description.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') };
}

function validateFormulaArgs(args: CreateVariableArgs): void {
  if (args.iobj_name && args.iobj_name.toUpperCase() !== FORMULA_IOBJ) {
    throw new Error(`A formula variable is not defined on a characteristic: leave iobj_name out (it is always ${FORMULA_IOBJ}).`);
  }
  const procType = args.processing_type ?? 'UserEntry';
  if (procType !== 'UserEntry' && procType !== 'CustomerExit') {
    throw new Error(`A formula variable is filled by "UserEntry" or "CustomerExit", not "${procType}".`);
  }
  if (args.represents && args.represents !== 'SingleValue') {
    throw new Error('A formula variable always represents a single value.');
  }
  if (args.dimension && !(FORMULA_DIMENSIONS as readonly string[]).includes(args.dimension)) {
    throw new Error(`dimension must be one of ${FORMULA_DIMENSIONS.join(', ')}.`);
  }
  if (args.default_value !== undefined && !Number.isFinite(args.default_value)) {
    throw new Error('default_value must be a finite number.');
  }
  checkUnitCurrency(args.dimension ?? 'Number', args.currency, args.unit);
}

/**
 * bw_create_variable — create a reusable BW Variable (TLOGO ELEM, xsi:type
 * Qry:Variable) of processing type CustomerExit on a characteristic.
 *
 * Wire protocol per payloads/bw_create_variable_customer_exit.md:
 *   1. compexist       → name check + server-generated ELEMUID
 *   2. lock (CREA)     → lockHandle, on the generic component enqueue endpoint
 *   3. transportchecks → package/transport handshake
 *   4. POST create     → full variable definition
 *   5. unlock
 *
 * Two details make or break this flow:
 *   - The enqueue endpoint is /comp/enq/<name>, not the generic /<type>/<name>
 *     lock that client.lock() builds, and it negotiates on the QUERY media type
 *     for every ELEM component — the variable media type yields HTTP 415 there.
 *   - Session isolation: the lock runs on a stateful enqueue session, the create
 *     POST on a fresh stateless one. The lockHandle itself is session-independent.
 *
 * Enum literals are unforgiving: the server silently coerces anything it does not
 * know back to the default and still reports the object as consistent, so a wrong
 * literal looks like success. The accepted values were read off existing variables
 * rather than guessed — the mandatory ones in particular are NOT "Mandatory" but
 * MandatoryWithInitial / MandatoryWithoutInitial. Mapping to the RSZGLOBV columns:
 *   procType   (VPROCTP): 1 ReplacementPath, 3 CustomerExit, 4 SAPExit,
 *                         5 UserEntry, 6 Authorization
 *   represents (VPARSEL): P SingleValue, I Interval, M SeveralSingleValues,
 *                         S SelectionOption, Q Query, T Precalculated
 *   inputType  (ENTRYTP): 0 Optional, 1 MandatoryWithInitial,
 *                         2 MandatoryWithoutInitial
 *   type       (VARTYP):  1 CharacteristicValue, 2 HierarchyNodes, 3 Text,
 *                         4 Formula, 5 Hierarchy
 *
 * Hierarchy and HierarchyNodes carry no extra payload — they differ from
 * CharacteristicValue in the type element alone; hierarchyName, version and dateTo
 * stay empty even on the SAP-delivered ones.
 *
 * A formula variable (type Formula, VARTYP 4) sits on the pseudo InfoObject 1FORMULA, carries
 * its dimension in dimIndicator (MWKZ: Number F, Amount W, Quantity M, Price P, Quota Q,
 * Date D, Time T) and a Constant default hint. Its default value is a selection on 1FORMULA
 * in defaultValues (RSZRANGE, I EQ value) — not defaultSelection, where a value is dropped —
 * and is parsed in the logon user's decimal notation (see userDecimalSeparator).
 *
 * A text variable (type Text, VARTYP 3) is a single value of up to 60 characters. By
 * replacement path it sits on the characteristic whose value it shows and is never ready for
 * input, and it can read the value from a characteristic variable on that characteristic instead
 * of from the characteristic itself; filled by a customer exit or user entry it sits on the
 * pseudo InfoObject 1TEXT with a Constant / 5 default hint, as on a formula variable.
 *
 * Deliberately not exposed: SAPExit (SAP-delivered, not something to create); and every
 * replacement-path variant of a characteristic variable except CurrentMember. QueryResult and HierarchyAttribute
 * need the internal UID of the donor query plus its InfoProvider, Key and Attribute
 * belong to text and formula variables. Always verify a new combination by reading
 * the object back before exposing it here.
 */
export async function bwCreateVariable(
  client: BwClient,
  args: CreateVariableArgs
): Promise<string> {
  const nameUpper = args.variable_name.toUpperCase();
  const nameLower = args.variable_name.toLowerCase();
  const variableType = args.variable_type ?? 'CharacteristicValue';
  const isFormula = variableType === 'Formula';
  const isText = variableType === 'Text';
  if (isFormula) validateFormulaArgs(args);
  else if (isText) validateTextArgs(args);
  else validateCharacteristicArgs(args);
  const procType = isText ? textProcType(args) : args.processing_type ?? 'UserEntry';
  const iobjName = isFormula
    ? FORMULA_IOBJ
    : isText && procType !== 'ReplacementPath'
      ? TEXT_IOBJ
      : args.iobj_name!.toUpperCase();
  const pkg = args.package ?? args.development_class ?? '$TMP';
  const transport = args.transport?.toUpperCase();
  const readyForInput = args.ready_for_input ?? (isText ? procType === 'UserEntry' : true);
  const reusable = args.reusable ?? true;
  const represents = isFormula || isText ? 'SingleValue' : args.represents ?? 'Interval';
  const inputType = args.input_type ?? 'Optional';
  const dimension = isFormula ? args.dimension ?? 'Number' : 'Blank';
  // Formula variables carry the hint Eclipse writes (Constant / 5) and attribute 1ATTRKEY; with
  // the characteristic-style hint value 1FORMULA the variable saves as consistent, but every
  // query computing with it fails with "DEFAULTHINT: value 1FORMULA not supported".
  const constantHint = isFormula || (isText && procType !== 'ReplacementPath');
  const hintType = constantHint ? 'Constant' : 'InfoObject';
  const hintValue = constantHint ? '5' : iobjName;
  const attributeAttr = isFormula ? ' attribute="1ATTRKEY"' : '';
  const defaultLiteral =
    isFormula && args.default_value !== undefined
      ? await formulaDefaultLiteral(client, args.default_value)
      : undefined;
  // Only the current-member variant is supported; it needs no donor object.
  const sourceVariable =
    isText && args.replacement_variable ? await resolveSourceVariable(client, args.replacement_variable, iobjName) : undefined;
  const replacementPathXml =
    isText && procType === 'ReplacementPath'
      ? textReplacementPathXml(args, sourceVariable)
      : procType === 'ReplacementPath'
      ? '<Qry:replacementPath type="CurrentMember" asBoolean="false" offsetStart="0000"' +
        ' offsetLength="0000" calculateBeforeNonCum="false"/>'
      : '';
  const language = args.master_language?.toUpperCase() ?? process.env.BW_LANGUAGE?.toUpperCase() ?? 'EN';
  const masterSystem = await resolveMasterSystem(client);
  const responsible = await resolveLogonUser(client);
  const timestampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const descEsc = escapeXml(args.description);

  const basePath = `/sap/bw/modeling/variable/${bwSeg(nameLower)}/a`;
  const enqPath = `/sap/bw/modeling/comp/enq/${bwSeg(nameLower)}`;

  // Step 1: compexist — name check + server-generated ELEMUID.
  const existResult = await client.rawGet(
    `/sap/bw/modeling/queryint?action=compexist&compid=${nameLower}&type=ELEM`,
    { 'bwmt-level': '50' }
  );
  if (header(existResult.headers, 'compexist') === 'true') {
    throw new Error(`A component named '${nameUpper}' already exists.`);
  }
  const elemUid = header(existResult.headers, 'elemuid');
  if (!elemUid) {
    throw new Error(
      `compexist did not return an ELEMUID header. Headers: ${JSON.stringify(existResult.headers)}`
    );
  }

  // Step 2: lock (CREA) on the enqueue endpoint.
  const lockResult = await client.rawPost(`${enqPath}?action=lock&compuid=${elemUid}`, '', {
    activity_context: 'CREA',
    Accept: `${queryWriteMediaType()}, ${QUERY_ACCEPT_LIST}`,
    'bwmt-level': '50',
    'x-csrf-token': await client.getCsrfToken(),
    ...lockSessionHeader(),
  });
  const lockHandle = lockResult.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandle) {
    throw new Error(`No <LOCK_HANDLE> in CREA lock response:\n${lockResult.body}`);
  }

  let messages: string[] = [];
  try {
    // Step 3: transportchecks.
    const transportBody = `<?xml version="1.0" encoding="UTF-8" ?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <PGMID></PGMID>
  <OBJECT>VAR</OBJECT>
  <OBJECTNAME>${elemUid}</OBJECTNAME>
  <DEVCLASS>${escapeXml(pkg)}</DEVCLASS>
  <SUPER_PACKAGE></SUPER_PACKAGE>
  <RECORD_CHANGES></RECORD_CHANGES>
  <OPERATION>I</OPERATION>
  <URI>${escapeXml(basePath)}?compuid=${elemUid}&amp;lockHandle=${lockHandle}</URI>
</DATA></asx:values></asx:abap>`;
    const transportResult = await client.rawPost(
      '/sap/bc/adt/cts/transportchecks',
      transportBody,
      {
        'Content-Type':
          'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
        'x-csrf-token': await client.getCsrfToken(),
        ...lockSessionHeader(),
      }
    );
    const transportRc = transportResult.body.match(/<RESULT>([^<]*)<\/RESULT>/)?.[1];
    if (transportRc === 'E') {
      throw new Error(`transportchecks failed for package '${pkg}':\n${transportResult.body}`);
    }

    // Step 4: POST create on a fresh session (the lockHandle is session-independent).
    const variableBody = `<?xml version="1.0" encoding="UTF-8"?>
<Qry:queryResource xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:adtcore="http://www.sap.com/adt/core">
  <Qry:schemaVersion>1.0</Qry:schemaVersion>
  <Qry:mainComponent xsi:type="Qry:Variable" id="${elemUid}" componentVersion="100" reusable="${reusable}" technicalName="${nameUpper}"${attributeAttr}${isText ? ' inputLength="0060"' : ` dimIndicator="${dimension}"`} infoObject="${iobjName}" readyForInput="${readyForInput}">
    <Qry:description default="false" value="${descEsc}"/>
    <Qry:defaultHint>
      <Qry:type>${hintType}</Qry:type>
      <Qry:value>${hintValue}</Qry:value>
    </Qry:defaultHint>
    <Qry:entityProperties adtcore:changedAt="${timestampIso}" adtcore:changedBy="${responsible}" adtcore:createdAt="${timestampIso}" adtcore:createdBy="${responsible}" adtcore:description="${descEsc}" adtcore:language="${language}" adtcore:name="${nameUpper}" adtcore:type="VAR" adtcore:masterLanguage="${language}" adtcore:masterSystem="${masterSystem}" adtcore:responsible="${responsible}">
      <adtcore:packageRef adtcore:packageName="${escapeXml(pkg)}" adtcore:type="VAR"/>
    </Qry:entityProperties>
    <Qry:defaultValues>
      ${defaultSelectionXml(iobjName, defaultLiteral)}
    </Qry:defaultValues>
    ${isFormula ? unitCurrencyXml(args.currency, args.unit) : ''}
    ${replacementPathXml}
    <Qry:type>${variableType}</Qry:type>
    <Qry:procType>${procType}</Qry:procType>
    <Qry:represents>${represents}</Qry:represents>
    <Qry:inputType>${inputType}</Qry:inputType>
  </Qry:mainComponent>
</Qry:queryResource>`;

    const corrNrPrefix = transport ? `corrNr=${transport}&` : '';
    const createClient = createClientFromEnv();
    const createResult = await createClient.rawPost(
      `${basePath}?compuid=${elemUid}&${corrNrPrefix}lockHandle=${lockHandle}`,
      variableBody,
      {
        'Development-Class': pkg,
        ELEMUID: elemUid,
        'Content-Type': `application/xml, ${variableWriteMediaType()}`,
        Accept: variableAccept(),
        'bwmt-level': '50',
        'x-csrf-token': await createClient.getCsrfToken(),
      }
    );
    messages = parseCheckResult(createResult.body, `Variable ${nameUpper} creation`);
  } finally {
    // Step 5: release the CREA lock — always, the create phase is over either way.
    try {
      await client.rawPost(`${enqPath}?action=unlock&compuid=${elemUid}`, '', {
        'bwmt-level': '50',
        'x-csrf-token': await client.getCsrfToken(),
      });
    } catch (unlockErr) {
      process.stderr.write(
        `Warning: failed to release CREA lock for variable/${nameLower}: ${unlockErr}\n`
      );
    }
  }

  return JSON.stringify(
    {
      success: true,
      variable_name: nameUpper,
      elemuid: elemUid,
      iobj_name: iobjName,
      description: args.description,
      package: pkg,
      processing_type: procType,
      variable_type: variableType,
      ...(isFormula ? { dimension } : {}),
      ...(defaultLiteral !== undefined ? { default_value: args.default_value } : {}),
      ...(isFormula && args.currency ? { currency: args.currency.toUpperCase() } : {}),
      ...(isFormula && args.unit ? { unit: args.unit.toUpperCase() } : {}),
      ...(isText && procType === 'ReplacementPath'
        ? {
            replacement_type: args.replacement_type ?? 'Key',
            replacement_interval: args.replacement_interval ?? 'FromValue',
            offset_start: args.offset_start ?? 0,
            offset_length: args.offset_length ?? 0,
            ...(sourceVariable ? { replacement_variable: sourceVariable.name } : {}),
          }
        : {}),
      represents,
      input_type: inputType,
      ready_for_input: readyForInput,
      reusable,
      master_language: language,
      messages,
    },
    null,
    2
  );
}
