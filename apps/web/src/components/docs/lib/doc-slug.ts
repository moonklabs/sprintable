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

/**
 * Derive a URL-safe slug from a doc title.
 * - lowercase, trim, collapse whitespace to single hyphens
 * - preserve Korean syllables/jamo (ㄱ-힝) and word chars; drop the rest
 * - collapse repeated hyphens and strip leading/trailing hyphens
 *
 * Returns '' when the title has no slug-able characters (caller keeps the
 * existing `untitled-<ts>` slug in that case).
 */
export function slugifyDocTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\wㄱ-힝-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** True for the auto-generated `untitled-<timestamp>` placeholder slug. */
export function isUntitledSlug(slug: string): boolean {
  return UNTITLED_SLUG_RE.test(slug);
}
