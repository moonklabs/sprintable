/**
 * story 4915 (PR 2) — where the proxy sends a PAGE load whose session it could NOT confirm: the access token was missing or expired, and the refresh call that would have renewed it was rejected · timed out ·
 * answered 5xx (`RefreshOutcome.kind === 'transient'` — «not known to be dead»; the cookies are kept). The proxy REWRITES the request to this public page (the address in the bar stays the page the person asked
 * for) — it does NOT let the request continue to the page: some handlers behind the proxy do no session check of their own (e.g. /desktop/downloads/macos.json, deliberately «behind a session» only through the
 * proxy's redirect), so «continue unauthenticated» would hand them out. The page draws the «다시 시도» screen; a retry (`router.refresh()`) asks again and the proxy tries the refresh once more.
 * A plain module (no React · no Next imports) so the proxy can import it without pulling a component into its bundle.
 */
export const SESSION_UNCONFIRMED_PATH = '/session-unconfirmed';
