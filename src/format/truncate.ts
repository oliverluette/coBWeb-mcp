/**
 * Upper bound for every tool result. A cut result says what is missing and how to
 * narrow the request, instead of letting the client cut it silently.
 */
export function truncate(text: string, maxChars: number, hint = 'Narrow the request (limit, types, part or a more specific name).'): string {
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - 300);
  const cut = text.lastIndexOf('\n', room);
  const kept = text.slice(0, cut > room / 2 ? cut : room);
  return `${kept}\n… truncated: showing ${kept.length} of ${text.length} characters. ${hint}`;
}
