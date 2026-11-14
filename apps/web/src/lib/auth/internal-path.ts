/**
 * story 4936 — the ONE place that decides «is this string an address inside this app». Every `next` · `return` · `redirect` value that ends in a navigation (`router.push` · `router.replace` ·
 * a 3xx `Location` · `window.location`) goes through here; no other file may write its own `startsWith('/')` guard (src/lib/auth/internal-path.guard.4936.test.ts reads the whole `src` for that).
 *
 * Why it is not «starts with `/`, not `//`, not `/\`»: the browser's URL parser DELETES tab · LF · CR anywhere in the string and reads `\` as `/`, so `/<TAB>/evil.com`, `/<LF>/evil.com`, `/<CR>/evil.com`
 * and `/<TAB>\evil.com` pass that old guard and then become `//evil.com` — another site (measured on dev 11-14: the app's router left the app with all of them). A value that is only percent-encoded
 * (`/%09/evil.com`, `/%2509/…`) is the same string one `decodeURIComponent` later, and several consumers decode once more (`safeNextPath`, `searchParams.get`), so every decoded form is checked too.
 *
 * A value is an internal path when, in its given form AND in each form after one · two · three `decodeURIComponent` (a value that cannot be decoded further stops there; more layers than that are refused):
 *   · it is a string of 1…MAX_LEN characters with no control character (U+0000–001F · U+007F) and no backslash anywhere
 *   · it starts with a single `/` (so not `//`, not `https://…`, not `javascript:…`)
 *   · parsed against a made-up origin it stays on that origin (the parser, not our reading of it, has the last word) — and the parsed (dot-segment-folded) `pathname + search + hash` passes the same «single `/` · no control · no backslash» test
 * The value is returned as it came — only judged, never rewritten.
 */
export const INTERNAL_PATH_MAX = 4096;
const MAX_DECODE_LAYERS = 3;
const PROBE_ORIGIN = 'https://internal-path.invalid';
const FORBIDDEN_ANYWHERE = /[\u0000-\u001f\u007f\\]/;
const LEGACY_UNICODE_ESCAPE = /%u[0-9a-f]{4}/i;

/** The ASCII `%XX` sequences of a form decoded one by one — what a lenient decoder would read when `decodeURIComponent` throws on some other, broken sequence of the same value. */
function lenientAsciiDecode(form: string): string {
  return form.replace(/%([0-7][0-9a-f])/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function oneFormIsInternal(form: string): boolean {
  if (form.length === 0 || form.length > INTERNAL_PATH_MAX) return false;
  if (FORBIDDEN_ANYWHERE.test(form)) return false;
  if (LEGACY_UNICODE_ESCAPE.test(form)) return false; // `%u002f` — the old `unescape` form some decoders still read
  if (!form.startsWith('/') || form.startsWith('//')) return false;
  let parsed: URL;
  try {
    parsed = new URL(form, PROBE_ORIGIN);
  } catch {
    return false;
  }
  if (parsed.origin !== PROBE_ORIGIN) return false;
  // the parser also FOLDS dot segments: `/..//evil.com` · `/.//evil.com` · `/a/..//evil.com` · `/%2e%2e//evil.com` stay on the origin but their pathname becomes `//evil.com` — and a consumer that rebuilds an address
  // from the parsed parts (or puts a `?p=` behind such a value) would hand out a protocol-relative address. So the normalized form is judged as well (found by 담롱's codex review of 4935, measured with node).
  const normalized = parsed.pathname + parsed.search + parsed.hash;
  return normalized.startsWith('/') && !normalized.startsWith('//') && !FORBIDDEN_ANYWHERE.test(normalized);
}

export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let form = value;
  for (let layer = 0; layer <= MAX_DECODE_LAYERS; layer += 1) {
    if (!oneFormIsInternal(form)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      // `decodeURIComponent` throws on a broken sequence elsewhere in the value (`%E0%A4%A`) — a LENIENT decoder would still read the good ones, so judge that reading too, then stop
      const lenient = lenientAsciiDecode(form);
      return lenient === form || oneFormIsInternal(lenient);
    }
    if (decoded === form) return true;
    form = decoded;
  }
  return false; // more encoding layers than any real address has
}

/** `value` when it is an internal path, else `fallback`. */
export function safeInternalPath(value: unknown, fallback: string): string {
  return isSafeInternalPath(value) ? value : fallback;
}
