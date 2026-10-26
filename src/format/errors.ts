/**
 * Error classes and the text the model gets back.
 *
 * Every failure becomes a tool result with `isError: true`: a short message without XML, HTML or
 * stack traces, the error class and a hint with the next sensible step.
 */
export type ErrorKind =
  | 'validation'
  | 'not_found'
  | 'locked'
  | 'not_allowed'
  | 'transport_required'
  | 'activation_failed'
  | 'session'
  | 'backend'
  | 'connection'
  | 'config'
  | 'not_implemented';

export class ToolError extends Error {
  override name = 'ToolError';
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

const MAX_MESSAGE = 600;

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * The readable part of a BW/ADT error body: the (localized) message of an ADT exception,
 * the message texts of a BW message list, or the first line of plain text.
 */
export function backendMessage(body: string): string {
  const localized = body.match(/<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/)?.[1];
  const message = body.match(/<message[^>]*>([\s\S]*?)<\/message>/)?.[1];
  const texts = [...body.matchAll(/<(?:\w+:)?(?:shortText|text|msgText)[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  const picked = localized ?? message ?? (texts.length > 0 ? texts.slice(0, 3).join(' / ') : undefined);
  const plain = picked ?? (body.trim().startsWith('<') ? '' : body.trim().split('\n')[0]);
  const text = decode(plain.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)} …` : text;
}

/** Turn any thrown value into a ToolError with a class and a hint. */
/**
 * Messages of the taken-over document writers name the tools they were written for; the
 * model knows coBWeb's tools only. Each name becomes the call that does the same here.
 */
const LEGACY_TOOLS: [RegExp, string][] = [
  [/bw_update_query_layout/g, 'bw_write (QUERY spec rows, columns, free)'],
  [/bw_update_query_key_figures\s+remove_member\s+with\s+the\s+member_id\s+bw_get_query\s+lists/g, 'bw_write (QUERY spec members_remove) with the member text bw_read(type="QUERY", part="members") lists'],
  [/bw_update_query_key_figures/g, 'bw_write (QUERY spec members)'],
  [/bw_update_query_filter/g, 'bw_write (QUERY spec filter)'],
  [/bw_update_query_characteristic/g, 'bw_write (QUERY spec characteristics)'],
  [/bw_update_query_settings/g, 'bw_write (QUERY spec settings)'],
  [/bw_update_query_cells/g, 'bw_write (QUERY spec cells)'],
  [/bw_update_query_\*?/g, 'bw_write (QUERY update)'],
  [/bw_get_query/g, 'bw_read(type="QUERY", detail="full")'],
];

export function translateLegacy(message: string): string {
  let m = message;
  for (const [re, to] of LEGACY_TOOLS) m = m.replace(re, to);
  return m
    .replace(/bw_get_(variable|ckf|rkf|structure)/g, (_x, t: string) => `bw_read(type="${t.toUpperCase()}")`)
    .replace(/bw_(create|update)_(variable|ckf|rkf|structure|query)\w*/g, (_x, a: string, t: string) => `bw_write (${a} ${t.toUpperCase()})`);
}

export function classify(err: unknown): ToolError {
  if (err instanceof ToolError) return /\bbw_(get|create|update)_/.test(err.message) ? new ToolError(err.kind, translateLegacy(err.message), err.hint) : err;
  const raw = translateLegacy(err instanceof Error ? err.message : String(err));
  const [head, ...rest] = raw.split('\n');
  const body = rest.join('\n');
  const status = Number(head.match(/HTTP (\d{3})/)?.[1] ?? 0);
  const detail = backendMessage(body) || head.replace(/\s*→\s*HTTP \d{3}.*/, '');
  const text = `${detail}${status ? ` (HTTP ${status})` : ''}`;

  if (/Required environment variable/.test(raw) || /BW_COOKIE_FILE/.test(head)) {
    return new ToolError('config', raw, 'The server has no BW connection configured. Set BW_URL, BW_USER and BW_PASSWORD (or BW_COOKIE_FILE) in the MCP server configuration and restart it.');
  }
  // Node network error codes, matched case-sensitively in the first line only: a BW body such as
  // "ExceptionResourceNotFound" must not read as ENOTFOUND.
  if (/\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b|socket hang up|timeout of \d+ms exceeded/.test(head)) {
    return new ToolError('connection', `BW system not reachable: ${head}`, 'Check that the BW system is running and BW_URL is correct, then retry.');
  }
  if (/session\s+timed\s+out/i.test(raw)) {
    return new ToolError('session', text, 'The BW session ended. Retry the call once; the server opens a new session.');
  }
  if (/locked|enqueue|currently being (edited|processed)/i.test(detail)) {
    return new ToolError('locked', text, 'Another user or session holds a lock on the object. Try again later.');
  }
  if (/transport request|correction|corrNr|CTS/i.test(detail) && status >= 400 && status < 500) {
    return new ToolError('transport_required', text, 'The package records changes. Pass a transport request in transport, or use $TMP.');
  }
  if (status === 404) {
    return new ToolError('not_found', text, 'Check the name and type with bw_search.');
  }
  if (status === 401 || status === 403) {
    // BW answers a delete of an object still in use with 403 as well.
    const hint = /^DELETE\b/.test(text)
      ? 'BW refused the delete: the object may still be in use (bw_context relation="where_used"), or the user lacks the authorization.'
      : "BW refused the request for this user. Check the user's BW authorizations.";
    return new ToolError('not_allowed', text, hint);
  }
  if (status >= 500) {
    return new ToolError('backend', text, 'BW failed to process the request (often a short dump). Retry once; if it fails again, check ST22 in BW.');
  }
  if (status >= 400) {
    return new ToolError('backend', text, 'BW rejected the request. Check the parameters against the message.');
  }
  return new ToolError('backend', head.length > MAX_MESSAGE ? `${head.slice(0, MAX_MESSAGE)} …` : head);
}

export function errorText(e: ToolError): string {
  return `Error (${e.kind}): ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`;
}

/**
 * The reason in a refused legacy result ({success:false, message | messages | error}). Of a
 * message list only errors and warnings are kept when there are any, so a step that did
 * succeed ("... saved") does not read like the outcome.
 */
export function legacyRefusal(r: Record<string, unknown>): string {
  if (typeof r['message'] === 'string' && r['message']) return r['message'];
  if (Array.isArray(r['messages']) && r['messages'].length) {
    const all = r['messages'].map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
    const bad = all.filter((m) => !/^(Information|Info|Success)\b/i.test(m));
    return (bad.length ? bad : all).join('; ');
  }
  if (typeof r['error'] === 'string' && r['error']) return r['error'];
  return 'refused';
}
