import { isSafeInternalPath } from '@/lib/auth/internal-path';

/**
 * story #4935 — where a person goes back to after making their FIRST project from «프로젝트 만들기»: the address they first pressed (`next`), with `?p=<the new project>` set by the URL API (never string concatenation —
 * `next` may already carry a `?` and its own `p`) and the internal retry mark `_prRetry` (proxy.ts `RESOLVE_RETRY_PARAM`: «this request already made one round trip») removed — the project exists now, so the trip is a fresh one.
 * Returns the in-app address (`path?query#hash`) or null when `next` is not a safe internal path — the caller then stays where it is. The parsed result must also stay on this origin: a check of the string alone is not
 * trusted to settle what the URL parser will read.
 */
export function returnHrefAfterProjectCreate(next: string | null | undefined, projectId: string, origin: string): string | null {
  if (!isSafeInternalPath(next)) return null;
  let url: URL;
  try { url = new URL(next, origin); } catch { return null; }
  if (url.origin !== new URL(origin).origin) return null;
  url.searchParams.delete('_prRetry');
  url.searchParams.set('p', projectId);
  // the URL API normalizes dot segments: `/..//evil.com` · `/.//evil.com` · `/a/..//evil.com` pass the check above but come out as `//evil.com?p=…` — another site. So the FINISHED address goes through the same check again.
  const href = `${url.pathname}${url.search}${url.hash}`;
  return isSafeInternalPath(href) ? href : null;
}
