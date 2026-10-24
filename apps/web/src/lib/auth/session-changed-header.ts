/**
 * story #4762 — the response header a route sets when it sets or clears the session cookies (`markSessionChanged` in `cookies.ts`), and the page's global fetch
 * gate (`installProjectHeaderInterceptor`) reads to tell the phone shell once. A file of its own (no server code in it) so the client gate can import the name
 * without pulling `cookies.ts` into the browser bundle.
 */
export const SESSION_CHANGED_HEADER = 'x-session-changed';
