/**
 * Server instructions sent at the handshake.
 * Only lines for offered tools are included, so the text never points at a tool that is absent.
 */
const TYPE_CODES =
  'Object types use BW TLOGO codes: AREA InfoArea, IOBJ InfoObject, ADSO, HCPR CompositeProvider, TRCS InfoSource, ' +
  'TRFN Transformation, DTPA DTP, RSDS DataSource, LSYS source system, RSPC process chain, QUERY, VARIABLE, CKF, RKF, ' +
  'STRUCTURE, ALVL aggregation level, FILTER planning filter, PLSE planning function, PLSQ planning sequence, HIER hierarchy, ' +
  'DEST Open Hub, ROLE.';

const STEPS: { tool: string; text: string }[] = [
  { tool: 'bw_search', text: 'bw_search finds objects and lists InfoAreas.' },
  { tool: 'bw_read', text: 'bw_read reads one object; detail="summary" is the default.' },
  { tool: 'bw_context', text: 'bw_context shows data flow and where-used.' },
  { tool: 'bw_describe', text: 'Call bw_describe(type) once before the first bw_write of a type.' },
  {
    tool: 'bw_write',
    text: 'bw_write creates, updates or deletes several objects in one call and activates them; the server orders them by dependency. Never pass lock handles: locks, sessions and activation order are handled by the server.',
  },
  { tool: 'bw_data', text: 'bw_data reads business data (queries, providers, previews).' },
  { tool: 'bw_monitor', text: 'bw_monitor shows loads and process chain runs; bw_run acts on them.' },
];

export function buildInstructions(offered: readonly string[]): string {
  const lines = ['coBWeb: SAP BW/4HANA modeling, one BW system per server instance.'];
  for (const s of STEPS) if (offered.includes(s.tool)) lines.push(s.text);
  lines.push(TYPE_CODES);
  lines.push('Errors say what to change; follow the hint instead of retrying unchanged.');
  return lines.join('\n');
}
