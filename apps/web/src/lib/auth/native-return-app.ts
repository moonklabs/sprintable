// story #4626 (PO 08:0xZ) — which desktop app a hand-back opens. Our Mac runs two dev apps (the setup app and the check app);
// both claimed `ai.sprintable:` and macOS gave each return to whichever registered last, so a sign-in or a «move» started in one
// came back to the other. The check app now has its own scheme and says so (`app=check`); everything else is unchanged.
//
// A CLOSED table — the only place a scheme is chosen. A value outside it (a typo, another app's name, a scheme, an empty value,
// another case) is the same as no value: the default. No caller ever puts a string from the URL into a link.
// story 4689 (PO 10-15): the phone apps too. 선생님's phone carries the dev app and the prod app side by side; both claimed `ai.sprintable:`, so
// the «앱으로 돌아가기» button opened the wrong app (or a chooser) and a prod sign-in that the server finished never finished in the app. The dev
// phone app now registers its own scheme (`ai.sprintable.dev`) and says so (`app=dev`, sent at the sign-in start); the prod app sends nothing.
// The default stays `ai.sprintable` byte for byte: the customer app, the setup app, the phone shell, and any path the web cannot
// tie to an app (an address typed by a person, outside an app's window) — PO 08:04Z.
// story 4696 (PO 10-15): …on the PRODUCTION web. The Mac's «Sprintable Dev Setup» now registers `ai.sprintable.dev` only (no longer
// `ai.sprintable`, which the prod app owns), and our crew's Macs have the dev setup app alone — so on the DEV web a link the page hands out
// without an `app` (a plain browser tab: the recruiter's «이 컴퓨터에서 시작», a setup / pairing link) must default to `ai.sprintable.dev`
// or nobody opens it. The default is chosen by this build's own public address (NEXT_PUBLIC_APP_URL, inlined at build time — same
// source as phone-app-store.ts): the dev web → `ai.sprintable.dev`; the production web, localhost, a test build, or an unset address →
// `ai.sprintable` (nothing changes there). A value outside the table is «no value», so it gets the host's default, never the value itself.

export type NativeReturnApp = 'check' | 'dev';

/** the query / cookie value an app sends — only these names mean anything */
export const RETURN_APP_PARAM = 'app';

const DEFAULT_SCHEME = 'ai.sprintable';
const DEV_DEFAULT_SCHEME = 'ai.sprintable.dev';
/** the dev web's host — the only host whose default differs (the production web, `app.sprintable.ai`, keeps `ai.sprintable`) */
const DEV_WEB_HOST = 'dev-app.sprintable.ai';
const SCHEMES: Readonly<Record<NativeReturnApp, string>> = Object.freeze({ check: 'ai.sprintable.check', dev: 'ai.sprintable.dev' });

/** the table's own entry for `value`, or null (the default) — exact match only */
export function nativeReturnApp(value: string | null | undefined): NativeReturnApp | null {
  return value === 'check' ? 'check' : value === 'dev' ? 'dev' : null;
}

/** story 4696: the scheme a link with no (or an off-table) `app` starts with — by this build's public address. Exactly the dev web's host
 *  → `ai.sprintable.dev`; everything else (the production host, localhost, a test build, an unset or unparsable address) → `ai.sprintable`. */
export function defaultScheme(appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string {
  let host = '';
  try { host = appUrl ? new URL(appUrl).hostname : ''; } catch { host = ''; }
  return host === DEV_WEB_HOST ? DEV_DEFAULT_SCHEME : DEFAULT_SCHEME;
}

/** the scheme (no colon) a link to that app starts with — with no app, the host's default (see `defaultScheme`) */
export function appScheme(app: NativeReturnApp | null): string {
  return app ? SCHEMES[app] : defaultScheme();
}

/** `/native/oauth-return`'s button: the app named by `app`. `app` itself is not handed on; every other value is, as before.
 *  With no `app` the link is the same as before, byte for byte (`ai.sprintable:/oauth-return?<the query as it came>`). */
export function appReturnUrl(searchParams: URLSearchParams): string {
  const base = `${appScheme(nativeReturnApp(searchParams.get(RETURN_APP_PARAM)))}:/oauth-return`;
  let query = searchParams.toString();
  if (searchParams.has(RETURN_APP_PARAM)) {
    const rest = new URLSearchParams(searchParams);
    rest.delete(RETURN_APP_PARAM);
    query = rest.toString();
  }
  return query ? `${base}?${query}` : base;
}

/** the setup page's «open the app» links (`/desktop/setup`, `?intent=reopen`) for that app · story 4670 (U2): `pair` = the app's band
 *  [폰 페어링] entry, as if pressed (the setup's end card [폰 페어링 열기]) — no setup starts.
 *  story 4680 (D2 · 4677): `agent` — the recruiter's [이 컴퓨터에서 시작] from a browser: the app reads `?agent=` (D1 mobile) and
 *  puts it in its setup page's fragment, so that agent is chosen there. Only a uuid-shaped id goes into the link. `intent` wins
 *  when both are given (a reopen/pair is the setup the person has — no agent to choose); no caller passes both today (PO 5065). */
export function appSetupLink(app: NativeReturnApp | null, intent?: 'reopen' | 'pair' | 'folder', opts?: { agent?: string | null; pick?: 'claude' | 'codex' | null }): string {
  const agent = opts?.agent && /^[0-9a-f-]{36}$/i.test(opts.agent) ? opts.agent : null;
  // story 4711: `intent=folder` asks the app for its Mac folder window; `pick` is the program the person had chosen (the app puts it back)
  const pick = intent === 'folder' && (opts?.pick === 'claude' || opts?.pick === 'codex') ? `&pick=${opts.pick}` : '';
  const q = intent ? `intent=${intent}${pick}` : agent ? `agent=${agent}` : '';
  return `${appScheme(app)}:/desktop/setup${q ? `?${q}` : ''}`;
}
