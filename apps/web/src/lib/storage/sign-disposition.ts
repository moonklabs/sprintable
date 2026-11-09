import type { IStorageService } from '@sprintable/core-storage';

// story 4860 — an uploaded file keeps the type its uploader declared, and the upload route stores that string without checking it: an uploader can pick text/html,
// image/svg+xml, but also `application/unknown`, `unknown/unknown`, `*/*`, `text/xsl`, `html`, `text`, `text /html` or no type at all — strings a browser
// answers by LOOKING AT THE CONTENT and, for markup, running its script. A signed read address opened at the top level of a tab is answered by the storage service
// with that stored type and, until now, `inline`.
//
// So the rule is an ALLOW list, not a list of dangerous types: a signed read address is made `inline` only for a stored type that is safe to draw on the screen
// (listed below). Every other type, a missing type and a type that cannot be read are signed `attachment` — opening such a file downloads it. A picture in an `<img>`,
// the reading panel (it fetches the bytes into a sandboxed frame), audio and video elements do not depend on the disposition, so previews do not change; what changes
// is «open original» of a file that is not on the list (an svg, a markup or unknown file): a download.

/** the exact types a browser draws without running anything: raster pictures (not svg), PDF, plain text */
const SAFE_INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'text/plain',
]);

/** audio / video: played by a media element, never drawn as a document. Strict token form — a wildcard, a space or a second type in the string is not one, and no `+`
 * (a `…+xml` subtype is an XML type a browser opens as a script-capable document, whatever the type before the slash says). */
const SAFE_MEDIA_TYPE = /^(?:audio|video)\/[a-z0-9][a-z0-9.-]*$/;

/** a stored type is judged only when it is printable ASCII (0x20–0x7e): a control character, a non-ASCII letter or a Unicode space (a no-break space, say) is read by a
 * browser differently from what JavaScript's lower-casing and trimming make of it, so such a string is never matched against the list — it is not on it */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** `type/subtype; charset=…` → the lower-cased, trimmed `type/subtype`; null when the string is not printable ASCII (anything else in the string stays in it and is judged as a whole) */
function baseType(contentType: string): string | null {
  if (!PRINTABLE_ASCII.test(contentType)) return null;
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * true only for a stored type that is safe to open inline: the raster pictures, PDF and plain text on the list, and audio / video of a well-formed type.
 * Everything else is false — including «no type recorded», a malformed string, a wildcard, and every markup or unknown type.
 */
export function isSafeInlineType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const t = baseType(contentType);
  if (t === null) return false;
  return SAFE_INLINE_TYPES.has(t) || SAFE_MEDIA_TYPE.test(t);
}

// A stored object's type never changes after upload, and a room opens many pictures at once: remember the answer for a short while (bounded).
const TYPE_CACHE_MAX = 500;
const TYPE_CACHE_TTL_MS = 10 * 60 * 1000;
const typeCache = new Map<string, { at: number; safe: boolean }>();

/** test hook: forget what was remembered */
export function resetSignDispositionCache(): void {
  typeCache.clear();
}

/**
 * The disposition a signed read address is made with.
 * - the caller asked for `attachment` (a download button): kept.
 * - otherwise `inline` only when the stored object's type is on the safe list (see above); any other type, no type: `attachment`.
 * - the type cannot be read (the storage service refuses or fails): `attachment` — a file that cannot be judged is not drawn as a page (the answer is not remembered).
 * - no such object: the requested disposition (there is nothing to serve).
 */
export async function resolveReadDisposition(
  storage: Pick<IStorageService, 'headObject'>,
  container: string,
  objectPath: string,
  requested: 'inline' | 'attachment',
): Promise<'inline' | 'attachment'> {
  if (requested === 'attachment') return 'attachment';
  const key = `${container}/${objectPath}`;
  const hit = typeCache.get(key);
  if (hit && Date.now() - hit.at < TYPE_CACHE_TTL_MS) return hit.safe ? 'inline' : 'attachment';
  let safe: boolean;
  try {
    const head = await storage.headObject(container, objectPath);
    if (head === null) return requested;
    safe = isSafeInlineType(head.contentType);
  } catch {
    return 'attachment';
  }
  if (typeCache.size >= TYPE_CACHE_MAX) {
    const oldest = typeCache.keys().next().value;
    if (oldest !== undefined) typeCache.delete(oldest);
  }
  typeCache.set(key, { at: Date.now(), safe });
  return safe ? 'inline' : 'attachment';
}
