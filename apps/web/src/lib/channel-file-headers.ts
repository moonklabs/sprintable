// story #4532 AC5 (Kadir · PO 21:59Z): a channel upload keeps its extension and the backend guessed its type from it — an «.html»
// (or an «.svg», which carries scripts too) came back as text/html and this route served it from our origin as it was: opening the
// link ran its script at the top level. Shown in place only for these types; anything else (whatever the backend says) is a
// download — octet-stream + attachment — and nothing is sniffed. The backend applies the same list; this route does not trust it.
export const CHANNEL_INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/webm',
  'application/pdf',
]);

/** The headers this route serves a channel file with, from the type the backend reported (parameters such as charset ignored). */
export function channelFileHeaders(reported: string | null): Record<string, string> {
  const type = (reported ?? '').split(';')[0]!.trim().toLowerCase();
  if (CHANNEL_INLINE_TYPES.has(type)) return { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
  return { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' };
}
