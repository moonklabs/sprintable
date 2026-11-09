import type { IStorageService } from '@sprintable/core-storage';

// story 4860 — an uploaded file keeps the type its uploader declared (a person or an agent can declare text/html or image/svg+xml with a script inside).
// A signed read address opened at the top level of a browser tab is answered by the storage service with that stored type and, until now, `inline`, so the browser
// drew the file as a page and ran its script (measured on dev: origin https://storage.googleapis.com, the file's `<script>` ran). The rule here: a file whose
// stored type is one a browser DRAWS AS A DOCUMENT THAT CAN CARRY SCRIPT is signed as `attachment` — opening it downloads it; nothing else changes
// (a picture in an `<img>`, the reading panel that fetches the bytes into a sandboxed frame, a PDF, text, audio and video do not depend on the disposition).

/** the plain types a browser renders at top level as a document that may run script: HTML and XML (an XML file in the XHTML or SVG namespace runs its `<script>`).
 * Every `…+xml` type (application/xhtml+xml, image/svg+xml, …) is caught by the suffix rule below. */
const ACTIVE_BASE_TYPES = new Set(['text/html', 'text/xml', 'application/xml']);

/** `type/subtype; charset=…` → the lower-cased `type/subtype` */
function baseType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * true for a stored type that opens as a script-capable document: text/html, application/xhtml+xml, text/xml, application/xml and every `…+xml` type
 * (image/svg+xml, application/mathml+xml, …). Everything else — including «no type recorded» (the storage service then answers a generic binary type, which a browser downloads) — is false.
 */
export function isActiveDocumentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const t = baseType(contentType);
  return ACTIVE_BASE_TYPES.has(t) || t.endsWith('+xml');
}

// A stored object's type never changes after upload, and a room opens many pictures at once: remember the answer for a short while (bounded).
const TYPE_CACHE_MAX = 500;
const TYPE_CACHE_TTL_MS = 10 * 60 * 1000;
const typeCache = new Map<string, { at: number; active: boolean }>();

/** test hook: forget what was remembered */
export function resetSignDispositionCache(): void {
  typeCache.clear();
}

/**
 * The disposition a signed read address is made with.
 * - the caller asked for `attachment` (a download button): kept.
 * - otherwise `inline`, unless the stored object is a script-capable document (see above): then `attachment`.
 * - the type cannot be read (the storage service refuses or fails): `attachment` — a file that cannot be judged is not drawn as a page (fail closed; the answer is not remembered).
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
  if (hit && Date.now() - hit.at < TYPE_CACHE_TTL_MS) return hit.active ? 'attachment' : 'inline';
  let active: boolean;
  try {
    const head = await storage.headObject(container, objectPath);
    if (head === null) return requested;
    active = isActiveDocumentType(head.contentType);
  } catch {
    return 'attachment';
  }
  if (typeCache.size >= TYPE_CACHE_MAX) {
    const oldest = typeCache.keys().next().value;
    if (oldest !== undefined) typeCache.delete(oldest);
  }
  typeCache.set(key, { at: Date.now(), active });
  return active ? 'attachment' : 'inline';
}
