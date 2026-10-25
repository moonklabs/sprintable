/**
 * story 4780 — where the phone's pairing screen (`/desktop/pair`) goes back to when it is done («Paired» · «already paired» · remote control off → [Close]).
 * The entries (Today's card · the chat head · the inbox · «원격 기기» · the phone's start screen) hand over the page they stand on as `?from=`; the pairing screen takes it back as
 * the [Close] target. A value that is not one of the app's own few phone screens is dropped (the screen then goes where it always went: `/desktop`) — the value comes from an address
 * anybody can write, so it is never taken as a destination as it is:
 *   · only a path of this app: one leading `/`, no `//` `/\` scheme or host (the address is parsed against a fixed host and must stay on it), no control characters, at most 512 long
 *   · only the phone screens that start a pairing, matched whole (no deeper path, so `/desktop/pair` itself — a loop — and an organization-prefixed path `/{org}/…` of this or another org are out)
 *   · only the project (`p`) of the query is kept: another parameter (`next` · `return` …) could send the page on somewhere else
 */
export const PAIR_RETURN_PARAM = 'from';

const MAX_LEN = 512;
const PROBE_ORIGIN = 'https://pair-return.invalid';
// the screens a pairing starts from, whole: Today · the inbox · the Mac screen (원격 기기) · the phone's start screen · a conversation · a workforce member's page (the chat head's strip)
const ALLOWED_PATH = /^\/(?:today|inbox|desktop|phone-start|chats(?:\/[A-Za-z0-9_-]{1,64})?|organization\/workforce\/[A-Za-z0-9_-]{1,64})\/?$/;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LEN) return null;
  if (CONTROL_OR_BACKSLASH.test(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  let url: URL;
  try { url = new URL(value, PROBE_ORIGIN); } catch { return null; }
  if (url.origin !== PROBE_ORIGIN) return null;
  if (!ALLOWED_PATH.test(url.pathname)) return null;
  const project = url.searchParams.get('p');
  return project ? `${url.pathname}?p=${encodeURIComponent(project)}` : url.pathname;
}

/**
 * the query that hands the page an entry stands on (`here` = that page's path + query) to the pairing screen: `?from=…` — or nothing when that page is not a return target (the entry then links the
 * address it always did). The address itself is written once, in `usePairHref` (wrapped by `useFlatHref`, so the project goes along).
 */
export function pairReturnQuery(here: string | null | undefined): string {
  const from = safeReturnPath(here);
  return from ? `?${PAIR_RETURN_PARAM}=${encodeURIComponent(from)}` : '';
}
