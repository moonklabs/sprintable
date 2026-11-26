/**
 * story 5042 (C9 · the desktop app's work panel) — the web addresses the app's panel loads in its own view: `/desktop/panel/…`. A panel address is a page for ONE small view inside the app window, so it is drawn
 * WITHOUT the web's own frame (no sidebar · no top bar · no bottom dock · no support launcher): the shell keeps its providers (the person · the org · the project) and draws only the page.
 * The rule is held here once — the shell and the layout read it from this file (the prefix is written inside the check, not as a constant: it is a test of an address, not a destination to link to). (`/desktop` is already a reserved first segment: it cannot be read as a workspace slug.)
 */
export function isPanelPath(pathname: string | null | undefined): boolean {
  return typeof pathname === 'string' && pathname.startsWith('/desktop/panel/');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** an id in a panel address is a uuid and nothing else (it is put into a request path: never any other text) */
export const isPanelId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
