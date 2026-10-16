// story 4712 — «브라우저 이어받기»: the Mac app opens the browser on /native/continue with its PKCE challenge; a signed-in person presses [열기];
// the server issues the existing one-time hand-off code for THAT challenge and the browser hands it to the app on this computer
// (`ai.sprintable[.dev]:/oauth-return?code=…`, the same return as a Google / Apple sign-in). Pure checks only — no new way to make a session.
//
// Kadir v2 lens (qasim/4712/lens-design-v2-1016.md), three conditions that live here and in the route:
//   1. where the code may go is a CLOSED table — `callback_mode` is `custom_scheme` only and `return_app` is `check` | `dev` | absent;
//      anything else is refused and the issue call is never made (an open return = the code to any place);
//   2. the code is issued only by the [열기] POST (the page itself issues nothing);
//   3. (the app side) a return with no pending verifier is dropped — in the mobile PR.
import { nativeReturnApp, RETURN_APP_PARAM, type NativeReturnApp } from '@/lib/auth/native-return-app';

/** a PKCE S256 challenge is base64url(sha256) with no padding — exactly 43 characters (the login start accepts `{43,}`; this one is stricter) */
export const CONTINUE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** under `/native/` with the existing return page (`/native/oauth-return`) — not under `/desktop/` (that folder is an app screen, a "flat destination") */
export const CONTINUE_PATH = '/native/continue';
const RETURN_APP_QUERY = 'return_app';

export interface ContinueStart {
  challenge: string;
  /** null = the host's default app (`ai.sprintable`, or `ai.sprintable.dev` on the dev web) */
  returnApp: NativeReturnApp | null;
}

interface Getter { get(name: string): string | null; has(name: string): boolean }

/** the app's start parameters, or null when any of them is off — nothing is partly accepted */
export function parseContinueStart(q: Getter): ContinueStart | null {
  const challenge = q.get('code_challenge');
  if (challenge === null || !CONTINUE_CHALLENGE_RE.test(challenge)) return null;
  if (q.get('cc_method') !== 'S256') return null;
  if (q.get('callback_mode') !== 'custom_scheme') return null;
  let returnApp: NativeReturnApp | null = null;
  if (q.has(RETURN_APP_QUERY)) {
    returnApp = nativeReturnApp(q.get(RETURN_APP_QUERY));
    if (returnApp === null) return null; // present but off the table (empty · another case · another app's name) → refused, not defaulted
  }
  return { challenge, returnApp };
}

const START_KEYS = ['code_challenge', 'cc_method', 'callback_mode', RETURN_APP_QUERY] as const;

/**
 * the four start parameters out of a request body or a page's search params — null when any of them is present but not ONE string (a number,
 * `null`, a list, a repeated query key). An optional `return_app` that is malformed must not read as «absent» and fall to the default app.
 * Other keys are not read at all.
 */
export function startParamsFrom(raw: Record<string, unknown>): URLSearchParams | null {
  const q = new URLSearchParams();
  for (const k of START_KEYS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    q.set(k, v);
  }
  return q;
}

/** the start parameters in the shape the page keeps them in its own address (for the sign-in round trip and the button's body) */
export function continueQuery(start: ContinueStart): string {
  const p = new URLSearchParams({ code_challenge: start.challenge, cc_method: 'S256', callback_mode: 'custom_scheme' });
  if (start.returnApp) p.set(RETURN_APP_QUERY, start.returnApp);
  return p.toString();
}

/** the page that hands the code to the app (a person taps there — the existing return page) */
export function continueReturnPath(code: string, returnApp: NativeReturnApp | null): string {
  const p = new URLSearchParams({ code });
  if (returnApp) p.set(RETURN_APP_PARAM, returnApp);
  return `/native/oauth-return?${p.toString()}`;
}
