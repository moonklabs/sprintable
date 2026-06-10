/**
 * Doc slug helpers — single source of truth for title→slug derivation.
 *
 * Previously this logic lived only in `docs-shell-client.tsx` (`generateSlug`),
 * which is dead code (mounted nowhere; imported only by its own test). The live
 * docs flow (`docs-client-layout` + `[slug]/page.tsx`) had no slug derivation,
 * so new docs kept their `untitled-<timestamp>` slug forever. Extracted here so
 * the live editor and the URL-edit dialog share one implementation.
 */

/** Matches the default slug assigned to a freshly-created, still-untitled doc. */
const UNTITLED_SLUG_RE = /^untitled-\d+$/;

/** Max slug length, in characters — must match the BE rule. */
export const DOC_SLUG_MAX_LENGTH = 200;

/**
 * Derive a URL-safe slug from a doc title.
 *
 * Locked spec (FE/BE parity — confirmed PO/Design 2026-06-10):
 * - NFC-normalize FIRST — composed vs decomposed 한글 (가 vs ㄱ+ㅏ) are
 *   distinct code points that both match `\p{L}`; without normalization the
 *   same title yields different slugs across input sources/FE/BE (parity break),
 *   produces false-duplicate collisions, and miscounts the length cap.
 * - preserve any Unicode letter or number: `\p{L} ∪ \p{N}` (keeps 한글/CJK/
 *   accented Latin, not just ASCII — the team's docs are Korean-dominant, so an
 *   ASCII-only rule would no-op the feature on the very titles it targets)
 * - whitespace → single hyphen
 * - drop everything else, INCLUDING `_` (not a letter/number)
 * - lowercase (affects Latin only; Korean/CJK have no case)
 * - collapse repeated hyphens, trim leading/trailing, cap at {@link DOC_SLUG_MAX_LENGTH}
 *
 * Returns '' when nothing slug-able remains (emoji/symbols only) — the caller
 * keeps the existing `untitled-<ts>` slug in that case.
 *
 * The BE mirrors this rule (incl. NFC normalization); both sides assert the
 * shared fixtures in `doc-slug.test.ts` to guard against drift. Note `\p{L}` is
 * Unicode-category based, NOT `\w` — JS `\w` is ASCII-only and Python `\w`
 * includes `_`, so both would diverge from this spec.
 */
export function slugifyDocTitle(title: string): string {
  return title
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DOC_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** True for the auto-generated `untitled-<timestamp>` placeholder slug. */
export function isUntitledSlug(slug: string): boolean {
  return UNTITLED_SLUG_RE.test(slug);
}
