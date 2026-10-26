/**
 * Query (QUERY): reader and writer.
 *
 * The summary is built for the model: one line per area, the filter and the variables in short
 * form, the members of each structure with their formula or selection. detail="full" adds every
 * member property, the cells and the complete settings; "raw" returns the document.
 */
import type { BwClient } from '../bw/client.js';
import { queryRoles } from './role.js';
import { bwSeg } from '../bw/client.js';
import { formatDimHierarchy, formatMemberSelection, parseQueryDocument, queryAccept, renderQueryText, type DimHierarchy } from '../legacy/query.js';
import { isNotFound, statusText, type ObjectAdapter, type ReadOptions } from './adapter.js';
import { SPEC_WORDS } from './components.js';
import { bwDelete } from '../legacy/delete.js';
import { applyQueryUpdate, checkQuerySpec, createQuery, queryBoundary, queryDependsOn } from './query-write.js';

type Rec = Record<string, unknown>;

async function readDoc(client: BwClient, name: string): Promise<{ xml: string; version: 'a' | 'm' }> {
  const base = `/sap/bw/modeling/query/${bwSeg(name)}`;
  try {
    return { xml: (await client.get(`${base}/a`, queryAccept())).body, version: 'a' };
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return { xml: (await client.get(`${base}/m`, queryAccept())).body, version: 'm' };
  }
}

export function parseQuery(name: string, xml: string, version: 'a' | 'm' = 'a'): Rec {
  return parseQueryDocument(xml, name, version === 'm' ? 'inactive version returned' : undefined);
}

/** "ZV_X (0CALMONTH, user_entry, mandatory, interval)": the words a VARIABLE spec uses. */
function variableShort(v: Rec): string {
  const w = (group: string, x: unknown) => SPEC_WORDS[group][String(x)] ?? String(x ?? '');
  const kind = w('kind', v['type']);
  const bits = [
    kind !== 'characteristic' ? kind : '',
    v['infoObject'] && !String(v['infoObject']).startsWith('1') ? String(v['infoObject']) : '',
    w('processing', v['procType']),
    v['inputType'] && v['inputType'] !== 'Optional' ? w('input', v['inputType']) : '',
    v['represents'] && v['represents'] !== 'SingleValue' ? w('selection', v['represents']) : '',
  ].filter(Boolean);
  return `${v['technicalName']} (${bits.join(', ')})`;
}

function dimLabel(d: Rec): string {
  if (d['type'] === 'CustomDimension') {
    const n = ((d['members'] as unknown[]) ?? []).length;
    const named = d['technicalName'] ? `${d['technicalName']} ` : '';
    return `structure ${named}"${d['description'] ?? ''}" (${n} member${n === 1 ? '' : 's'})${d['reusable'] ? ', reusable' : ''}`;
  }
  const name = String(d['infoObjectName'] ?? d['technicalName'] ?? d['description'] ?? '?');
  // The display hierarchy goes with the characteristic: a filter on a hierarchy node needs it.
  return d['hierarchy'] ? `${name} [${formatDimHierarchy(d['hierarchy'] as DimHierarchy).replace(/^Hierarchy: /, 'hierarchy ').replace(/ \((active|assigned, not active)\)/, (_, x: string) => (x === 'active' ? '' : ', not active'))}]` : name;
}

const OP_WORD: Record<string, string> = { Equal: 'eq', Between: 'between', GreaterThan: 'gt', GreaterEqual: 'ge', LessThan: 'lt', LessEqual: 'le', Contains: 'pattern' };

function filterLine(f: Rec): string {
  const v = f['variable'] as Rec | undefined;
  if (v) return `${f['infoObject']} = variable ${v['technicalName']}`;
  const fixed = (f['fixedValues'] as Rec[] | undefined) ?? [];
  if (fixed.length) {
    const tokens = fixed.map((t) => `${t['exclude'] ? 'not ' : ''}${OP_WORD[String(t['operator'])] ?? t['operator']} ${t['value']}${t['highValue'] !== undefined ? `..${t['highValue']}` : ''}`);
    return `${f['infoObject']}: ${tokens.join(', ')}`;
  }
  return formatMemberSelection([f]) || String(f['infoObject'] ?? '?');
}

/** Member line: kind, description, then formula or selection and the properties that are set. */
function memberLines(members: Rec[], indent: string, full: boolean, out: string[]): void {
  for (const m of members) {
    const kind = m['type'] === 'MemberFormula' ? 'formula' : m['inverseFor'] ? 'inverse' : 'selection';
    const what = m['formula'] ? String(m['formula']) : formatMemberSelection((m['selections'] as Rec[] | undefined) ?? []);
    const props: string[] = [];
    if (m['decimals'] !== undefined) props.push(`decimals ${m['decimals']}`);
    const scaling = m['scaling'] as Rec | undefined;
    if (scaling?.['number'] !== undefined) props.push(`scaling ${scaling['number']}`);
    if (m['visibility'] && m['visibility'] !== 'showAlways') props.push(String(m['visibility']));
    const planning = m['planning'] as Rec | undefined;
    if (planning?.['inputMode'] && planning['inputMode'] !== 'default' && planning['inputMode'] !== 'not') props.push('input ready');
    if (planning?.['disaggregation'] && planning['disaggregation'] !== 'default') props.push(`disaggregation ${planning['disaggregation']}`);
    if (m['signInversion'] === true) props.push('sign inverted');
    if (m['constantSelection'] === true) props.push('constant selection');
    const ea = m['exceptionAggregation'] as Rec | undefined;
    if (ea) props.push(`exception aggregation ${ea['type']}${ea['referenceCharacteristics'] ? ` over ${(ea['referenceCharacteristics'] as string[]).join(', ')}` : ea['referenceCharacteristic'] ? ` over ${ea['referenceCharacteristic']}` : ''}`);
    const calc = m['calculation'] as Rec | undefined;
    if (calc && full) {
      if (calc['result_as'] && calc['result_as'] !== 'blank') props.push(`results as ${calc['result_as']}`);
      if (calc['single_values_as'] && calc['single_values_as'] !== 'blank') props.push(`single values as ${calc['single_values_as']}`);
      if (calc['cumulation']) props.push('cumulated');
    }
    if (full && m['id']) props.push(`id ${m['id']}`);
    out.push(`${indent}${kind.padEnd(9)} ${m['description'] ?? m['id'] ?? ''}${what ? ` = ${what}` : ''}${props.length ? `  [${props.join(', ')}]` : ''}`);
    const children = [...((m['childMembers'] as Rec[]) ?? []), ...((m['childFormulas'] as Rec[]) ?? [])];
    if (children.length) memberLines(children, `${indent}  `, full, out);
  }
}

/** Settings that differ from what a new query has. */
function settingLines(q: Rec): string[] {
  const s = (q['settings'] as Rec) ?? {};
  const out: string[] = [];
  const zs = (s['zeroSuppression'] as Rec) ?? {};
  if (zs['rows'] || zs['columns']) out.push(`zero suppression ${[zs['rows'] ? 'rows' : '', zs['columns'] ? 'columns' : ''].filter(Boolean).join(' and ')}`);
  const rp = (s['resultPosition'] as Rec) ?? {};
  if (rp['onTop']) out.push('result rows on top');
  if (rp['onLeft']) out.push('result columns on the left');
  if (s['signPresentation'] && s['signPresentation'] !== 'inFrontOf') out.push(`sign ${s['signPresentation']}`);
  const kd = s['keyDate'] as Rec | undefined;
  if (kd && kd['kind'] === 'variable') out.push(`key date from variable ${kd['variable']}`);
  if (kd && kd['kind'] === 'fixed') out.push(`key date ${kd['date']}`);
  if (s['rfcEnabled']) out.push('RFC');
  if (s['odataSupport']) out.push('OData');
  if (s['easyQuery']) out.push('EasyQuery');
  const planning = s['planning'] as Rec | undefined;
  if (planning?.['inputMode']) out.push('planning: start in change mode');
  if (s['suppressRepeatedKeyValues']) out.push('repeated key values suppressed');
  if (s['showScalingFactor']) out.push('scaling factor shown');
  return out;
}

export function summarizeQuery(q: Rec, part?: string, detail: 'summary' | 'full' = 'summary'): string {
  const full = detail === 'full';
  const head = `QUERY ${q['name']} "${q['description'] ?? ''}" · ${statusText(String(q['status'] ?? ''))} · on ${q['providerTlogo'] ?? q['providerType'] ?? '?'} ${q['infoProvider'] ?? '?'} · InfoArea ${q['infoArea'] || '?'} · package ${q['package'] || '?'}`;
  const rows = (q['rows'] as Rec[]) ?? [];
  const columns = (q['columns'] as Rec[]) ?? [];
  const free = (q['freeCharacteristics'] as Rec[]) ?? [];
  const layout = [
    `Rows: ${rows.map(dimLabel).join(', ') || 'none'}`,
    `Columns: ${columns.map(dimLabel).join(', ') || 'none'}`,
    `Free: ${free.map(dimLabel).join(', ') || 'none'}`,
  ];
  const filter = (q['filter'] as Rec[]) ?? [];
  const filterPart = filter.length ? [`Filter: ${filter.map(filterLine).join('; ')}`] : ['Filter: none'];
  const variables = (q['variables'] as Rec[]) ?? [];
  const varPart = variables.length
    ? full
      ? [`Variables (${variables.length}):`, ...variables.map((v) => `  ${variableShort(v)}${(v['usedIn'] as string[] | undefined)?.length ? ` · used in ${(v['usedIn'] as string[]).join('; ')}` : ''}`)]
      : [`Variables (${variables.length}): ${variables.map(variableShort).join('; ')}`]
    : [];
  const structures: string[] = [];
  for (const [axis, dims] of [['rows', rows], ['columns', columns]] as const) {
    for (const d of dims) {
      if (d['type'] !== 'CustomDimension') continue;
      structures.push(`Structure "${d['description'] ?? ''}"${d['technicalName'] ? ` (${d['technicalName']})` : ''} in ${axis}:`);
      memberLines((d['members'] as Rec[]) ?? [], '  ', full, structures);
    }
  }
  const grid = (q['gridCells'] as Rec[]) ?? [];
  const help = (q['helpCells'] as Rec[]) ?? [];
  const cells = grid.length || help.length ? [`Cells: ${grid.length} at intersections, ${help.length} help cells${full ? '' : ' (part="cells" lists them)'}`] : [];
  const settings = settingLines(q);
  const settingPart = settings.length ? [`Settings: ${settings.join(' · ')}`] : [];
  const extras: string[] = [];
  const exceptions = (q['exceptions'] as unknown[]) ?? [];
  if (exceptions.length) extras.push(`Exceptions: ${exceptions.length}`);
  if (q['versionNote']) extras.push(`Note: ${q['versionNote']}`);

  const p = part?.toLowerCase();
  if (p === 'layout') return [head, ...layout].join('\n');
  if (p === 'filter') return [head, ...filterPart].join('\n');
  if (p === 'variables') return [head, ...(varPart.length ? varPart : ['Variables: none'])].join('\n');
  if (p === 'members' || p === 'structures' || p === 'key_figures') return [head, ...(structures.length ? structures : ['No structure.'])].join('\n');
  if (p === 'settings') return [head, ...(settingPart.length ? settingPart : ['Settings: as a new query'])].join('\n');
  if (p === 'cells') {
    // The cell section of the complete text names every cell with the members it sits on.
    const text = renderQueryText(q);
    const at = text.indexOf('── Cell');
    return [head, at >= 0 ? text.slice(at).trimEnd() : 'No cells.'].join('\n');
  }
  if (full) return renderQueryText(q);
  return [head, ...layout, ...filterPart, ...varPart, ...structures, ...cells, ...settingPart, ...extras].join('\n');
}

const DESCRIBE_CREATE = [
  'QUERY create spec (package $TMP)',
  '  provider      InfoProvider (ADSO, HCPR, aggregation level, InfoObject)      (required unless copy_from)',
  '  description   text, max 60',
  '  copy_from     query to copy: layout, filter, variables and members come along',
  '  and any update field, applied right after the create',
].join('\n');

const DESCRIBE_UPDATE = [
  'QUERY update spec (only the named sections change; same spec again = unchanged)',
  '  rows, columns, free  complete list of the area: characteristics, or {structure: NAME} (reusable);',
  '                a characteristic not listed leaves the area, one listed elsewhere moves there',
  '  filter        per characteristic: {field, values, exclude} | {field, selections: [{op eq|ne|between,',
  '                low, high, exclude}]} | {field, variable}; values [] removes the filter',
  '  members       complete ordered list of the key figure structure (created in columns, or',
  '                members_axis rows): "ZAMOUNT" | {key_figure | ckf | rkf, description, restrictions}',
  '                | {formula, description}; matched by description, else by what they show',
  '  members_add, members_remove (texts)   instead of members',
  '  member properties (in entries or member_properties [{member, …}]): decimals 0-9, scaling 0-9,',
  '                visibility hide|always|never, sign_inversion, input_ready, disaggregation',
  '                copy|no|absolute, disaggregation_reference, constant_selection,',
  '                calculation {results_as, single_values_as, apply_to_result, cumulation},',
  '                exception_aggregation {type, over, all_others} (formulas), parent, position',
  '  characteristics [{field ("*" = all), area, display key|text|key_text|text_key|none,',
  '                result_rows always|if_more|never, sorting {by key|text, direction},',
  '                access master_data|posted|relations, cumulate on|off, display_level,',
  '                hierarchy {name, active, expand_to_level, …}}]',
  '  settings      {zero_suppression {rows, columns}, result_position {top, left}, sign,',
  '                suppress_repeated_keys, show_scaling_factor, zero_as, document_links, display_hierarchy}',
  '  cells         operations [{action add_reference|add_formula|add_help|update|remove, row_member,',
  '                column_member, cell, description, formula ("text" = cell), key_figure, restrictions}]',
  '  roles_add, roles_remove  [{role, folder}]',
  '  description',
  'Formula text: key figures by name, "member text", ckf:/rkf:/var:NAME, numbers, + - * / ** and BW',
  'functions, e.g. NDIV0("Amount" / "Quantity"). Values of time characteristics as 202601 or 01.2026.',
  'Example',
  '  {"action":"update","type":"QUERY","name":"ZCW_Q1","spec":{"rows":["0CALMONTH"],"members":["ZAMOUNT",{"formula":"\\"ZAMOUNT\\" * 2","description":"Double"}],"filter":[{"field":"ZREGION","values":["EU"]}]}}',
].join('\n');

async function readParsed(client: BwClient, name: string): Promise<Rec> {
  const { xml, version } = await readDoc(client, name);
  return parseQuery(name, xml, version);
}

export const queryAdapter: ObjectAdapter = {
  type: 'QUERY',
  label: 'Query',

  async locate(client, name) {
    try {
      const { xml, version } = await readDoc(client, name);
      const q = parseQuery(name, xml, version);
      return {
        exists: true,
        infoArea: (q['infoArea'] as string) || undefined,
        package: (q['package'] as string) || undefined,
        active: version === 'a' && q['status'] === 'active',
      };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async read(client, name, { detail, part }: ReadOptions) {
    const { xml, version } = await readDoc(client, name);
    if (detail === 'raw') return xml;
    const q = parseQuery(name, xml, version);
    if (part?.toLowerCase() === 'roles') return `${summarizeQuery(q, 'layout').split('\n')[0]}\n${await queryRoles(client, name)}`;
    return summarizeQuery(q, part, detail === 'full' ? 'full' : 'summary');
  },

  describe(action) {
    return action === 'create' ? `${DESCRIBE_CREATE}\n${DESCRIBE_UPDATE.replace(/^QUERY update spec[^\n]*\n/, '')}` : DESCRIBE_UPDATE;
  },
  check: checkQuerySpec,
  dependsOn: queryDependsOn,
  boundary: queryBoundary,
  targetInfoArea() {
    return undefined;
  },
  async create(name, spec, ctx) {
    return createQuery(ctx.client, name, spec as Rec, ctx, () => readParsed(ctx.client, name));
  },
  async update(name, spec, ctx) {
    const notes = await applyQueryUpdate(ctx.client, name, spec as Rec, ctx, () => readParsed(ctx.client, name));
    return notes.length ? { status: 'changed', activated: true, notes } : { status: 'unchanged' };
  },
  async delete(name, ctx) {
    await bwDelete(ctx.client, 'query', name);
    return { status: 'deleted' };
  },
};
