'use client';

import Script from 'next/script';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, Suspense } from 'react';

const GA_ID = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
    dataLayer: unknown[];
  }
}

// story 4719 (Kadir · PO 10-16) — what Analytics may see of an address. A one-time value can ride in the query of a screen (a password reset or
// set-password token, an e-mail verification token, an invite token, an unsubscribe token, the app's one-time hand-off code); the address is
// what gtag reports as `page_path` / `page_location` and, on the next same-site screen, as `page_referrer`. So:
//   1. the query (and the `#` part) never goes to Analytics, on any screen — path-level analysis stays;
//   2. these screens are not reported at all (and the tag is switched off while one is open, so even its automatic events say nothing);
//   3. a screen whose query carries a token / code style key is not reported either, whatever its path.
// One place (this file): the list, the guard and the three values.

/** Screens that take a one-time value in their address — Analytics is not called for them. Names of the FIRST path segment (not paths: this is a
 *  predicate table, not a navigation target), so `native` covers `/native` and everything below it. */
export const NO_ANALYTICS_SEGMENTS = [
  'native', 'reset-password', 'set-password', 'verify-email', 'invite', 'unsubscribe',
  // a public document link carries its secret in the PATH (`/share/<token>`) — whoever knows it can open the document (found by Mirko, 5130)
  'share',
  // the app's own screens take their one-time codes in the `#` part (the setup code on /desktop/setup, the remote-control code on /desktop/remote, …)
  'desktop',
] as const;

/** the first segment of a path, lower-cased: `/Reset-Password/x` → `reset-password` · `/` → '' */
function firstSegment(pathname: string): string {
  return pathname.toLowerCase().split('/')[1] ?? '';
}

/** Query keys that carry a one-time or secret value — a screen whose address has one of them is not reported, whatever its path. */
export const ONE_TIME_QUERY_KEYS = [
  'token', 'code', 'otp', 'key', 'secret', 'state', 'nonce', 'password', 'ticket', 'session', 'magic', 'sig', 'signature',
  'invite_token', 'reset_token', 'access_token', 'refresh_token', 'id_token', 'code_verifier', 'code_challenge', 'verifier',
  // the card-payment return (Toss): `authKey` makes the billing key once, `paymentKey` / `customerKey` name a payment / a payer
  'authkey', 'paymentkey', 'customerkey',
] as const;

interface QueryReader { has(name: string): boolean; keys(): IterableIterator<string>; entries(): IterableIterator<[string, string]> }

/** how many address-inside-a-value levels are read (`?next=/a?redirect=/b?continue=/c?token=…` is three) — the inline init expression uses the same number */
export const NEST_DEPTH_MAX = 5;

function hasOneTimeKey(q: QueryReader, depth = 0): boolean {
  for (const [k, v] of q.entries()) {
    if ((ONE_TIME_QUERY_KEYS as readonly string[]).includes(k.toLowerCase())) return true;
    // a value that is itself an address with a query (`/login?next=/invite/accept?token=…`): read down the same way
    if (depth < NEST_DEPTH_MAX && v.includes('=')) {
      const nested = v.includes('?') ? v.slice(v.indexOf('?') + 1) : v;
      if (hasOneTimeKey(new URLSearchParams(nested), depth + 1)) return true;
    }
  }
  return false;
}

/** `hash` = the `#` part of the address (with or without the `#`), read like a query — a one-time value can ride there too */
export function isAnalyticsExcluded(pathname: string, query: QueryReader | null, hash: string = ''): boolean {
  if ((NO_ANALYTICS_SEGMENTS as readonly string[]).includes(firstSegment(pathname))) return true;
  if (query && hasOneTimeKey(query)) return true;
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment.includes('=') && hasOneTimeKey(new URLSearchParams(fragment))) return true;
  return false;
}

/** the address as Analytics may see it: origin + path, never the query or the `#` part */
export function analyticsLocation(origin: string, pathname: string): string {
  return `${origin}${pathname}`;
}

/** a referrer (the address the person came from) with its query and `#` part removed; '' when it is not an address — and '' when it is an
 *  address of THIS site that is not reported (a share link's path, a token screen): the browser hands a same-site referrer over whole, so a
 *  full page load that came from `/share/<secret>` would otherwise tell Analytics where it came from */
export function analyticsReferrer(referrer: string, ownOrigin: string = typeof window !== 'undefined' ? window.location.origin : ''): string {
  if (!referrer) return '';
  try {
    const u = new URL(referrer);
    if (ownOrigin && u.origin === ownOrigin && isAnalyticsExcluded(u.pathname, u.searchParams, u.hash)) return '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** the same rule as `analyticsReferrer`, as the expression the inline init script evaluates (it runs before any of this file's code can) */
export function initReferrerExpression(): string {
  return `(function(){ try {
              var r = new URL(document.referrer);
              if (r.origin === location.origin) {
                var L = ${JSON.stringify(NO_ANALYTICS_SEGMENTS)}, K = ${JSON.stringify(ONE_TIME_QUERY_KEYS)}, M = ${NEST_DEPTH_MAX}, p = (r.pathname.toLowerCase().split('/')[1] || '');
                if (L.indexOf(p) >= 0) return '';
                var bad = function (q, d) {
                  var it = q.entries(), n, v, s;
                  while (!(n = it.next()).done) {
                    if (K.indexOf(n.value[0].toLowerCase()) >= 0) return true;
                    v = n.value[1];
                    if (d < M && v.indexOf('=') >= 0) { s = v.indexOf('?') >= 0 ? v.slice(v.indexOf('?') + 1) : v; if (bad(new URLSearchParams(s), d + 1)) return true; }
                  }
                  return false;
                };
                var h = r.hash.charAt(0) === '#' ? r.hash.slice(1) : r.hash;
                if (bad(r.searchParams, 0)) return '';
                if (h.indexOf('=') >= 0 && bad(new URLSearchParams(h), 0)) return '';
              }
              return r.origin + r.pathname;
            } catch (e) { return ''; } })()`;
}

function disableFlag(): string { return `ga-disable-${GA_ID}`; }

/** how long the opt-out flag is held after leaving an excluded screen when no route change follows (a `#` change · a back to the same page) */
export const HOLD_MS = 1500;

function GoogleAnalyticsInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const excluded = isAnalyticsExcluded(pathname ?? '', searchParams);
  // the tag is loaded only once a screen that may be reported has been shown (a person who lands on a token screen never loads it)
  const [armed, setArmed] = useState(false);
  // bumped when a held flag is released without a route change (a `#` that went away): both effects run again, so the screen is reported (and a
  // pending `sign_up` sent) even when the tag was already armed
  const [tick, setTick] = useState(0);
  // the clean address of the screen before this one (the referrer of a same-site move) — never its query. null = no screen of ours yet (the
  // document's own referrer applies); '' = the screen before was not reported (a token / share screen): no referrer is claimed — not even its path
  const previous = useRef<string | null>(null);
  // the address already reported — the effect also re-runs when `armed` flips, and must not report the same screen twice (its referrer would be itself)
  const reported = useRef<string>('');
  const signedUp = useRef<string>('');
  // the referrer the last reported screen was sent with — the `sign_up` event of that screen carries the same one
  const lastReferrer = useRef<string | null>(null);
  // LEAVING a token screen: Analytics' own history hit (enhanced measurement) fires AT the move, with the token screen's full address as its
  // referrer. The opt-out flag therefore stays ON through the move and is released only after this component has sent its own, clean hit for
  // the new screen (the route effect) — or after HOLD_MS, for a move that produces no route change (a `#` change, a back to the same page).
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Analytics' own opt-out flag: while a token screen is open nothing is sent — not even the tag's automatic events (scroll · click · …)
    // the `#` part is read here (the render does not see it): a one-time value in it excludes the screen as well
    const excludedNow = excluded || isAnalyticsExcluded(pathname ?? '', null, window.location.hash);
    // the new screen's own hit goes out below with the flag released just before it; a screen that is not reported keeps the flag on
    if (hold.current) { clearTimeout(hold.current); hold.current = null; }
    if (GA_ID) (window as unknown as Record<string, unknown>)[disableFlag()] = excludedNow;
    if (excludedNow) { previous.current = ''; reported.current = ''; return; }
    setArmed(true);
    if (!GA_ID || !window.gtag) return; // the tag is not defined yet (it loads right after `armed`) — this effect runs again then
    const here = analyticsLocation(window.location.origin, pathname ?? '');
    if (reported.current === here) return;
    reported.current = here;
    const referrer = previous.current ?? analyticsReferrer(document.referrer);
    lastReferrer.current = referrer;
    window.gtag('config', GA_ID, {
      page_path: pathname,
      page_location: here,
      page_referrer: referrer,
    });
    previous.current = here;
  }, [pathname, searchParams, excluded, armed, tick]);

  // A client-side move to a token screen: the tag's own history handling can fire before the effect above has switched it off. So the
  // opt-out flag is set from the DESTINATION address, synchronously, inside pushState / replaceState (installed before the tag loads).
  useEffect(() => {
    if (!GA_ID || typeof window === 'undefined') return;
    const flag = disableFlag();
    const w = window as unknown as Record<string, unknown>;
    const here = () => isAnalyticsExcluded(window.location.pathname, new URLSearchParams(window.location.search), window.location.hash);
    // the destination decides the flag at once; a move AWAY from an excluded address keeps it on (held) — see `hold` above. Released by the route
    // effect, or by the timer when no route change follows.
    const follow = (destinationExcluded: boolean, leavingExcluded: boolean) => {
      // an address that is not reported becomes «the screen before» for the next one — which must not name the one it replaced either
      if (destinationExcluded) { w[flag] = true; previous.current = ''; reported.current = ''; return; }
      if (!leavingExcluded) { w[flag] = false; return; }
      w[flag] = true;
      if (hold.current) clearTimeout(hold.current);
      hold.current = setTimeout(() => {
        hold.current = null;
        const excludedNow = here();
        w[flag] = excludedNow;
        // a move that left an excluded address without any route change (a `#` that went away) and is clean now: the screen may be reported
        // from here on (the route effect also runs when `armed` flips — it sends the first, clean hit)
        if (!excludedNow) setTick((t) => t + 1); // the route effect runs again: it arms the tag (a clean address) and reports the screen
      }, HOLD_MS);
    };
    const wrap = (name: 'pushState' | 'replaceState') => {
      const original = window.history[name];
      window.history[name] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
        const flagBefore = w[flag];
        const previousBefore = previous.current;
        const reportedBefore = reported.current;
        if (url !== undefined && url !== null) {
          try {
            const to = new URL(String(url), window.location.href);
            follow(isAnalyticsExcluded(to.pathname, to.searchParams, to.hash), here());
          } catch { /* not an address — the effect above decides after the move */ }
        }
        try {
          return original.call(this, data, unused, url);
        } catch (e) {
          // the browser refused the move (a cross-origin address · a size limit): no move happened, so the flag is what it was — not left on
          if (hold.current) { clearTimeout(hold.current); hold.current = null; }
          w[flag] = flagBefore;
          previous.current = previousBefore;
          reported.current = reportedBefore;
          throw e;
        }
      } as History['pushState'];
      return () => { window.history[name] = original; };
    };
    const undoPush = wrap('pushState');
    const undoReplace = wrap('replaceState');
    // back / forward and a changed `#` move the address without pushState: the flag follows `location` when the browser says it moved
    // (capture phase — before the tag's own listeners)
    // (here `location` is already the destination: «leaving» is what the flag says — it is on only while an excluded screen was open or held)
    const followLocation = () => follow(here(), w[flag] === true);
    window.addEventListener('popstate', followLocation, true);
    window.addEventListener('hashchange', followLocation, true);
    return () => {
      window.removeEventListener('hashchange', followLocation, true);
      window.removeEventListener('popstate', followLocation, true);
      undoReplace(); undoPush();
      if (hold.current) { clearTimeout(hold.current); hold.current = null; }
    };
  }, []);

  // story #3204 — 전환 이벤트 발화 SSOT. 가입 경로 2개(email/pw는 register/page.tsx,
  // OAuth는 api/auth/callback/[provider]/route.ts 서버 리다이렉트라 클라 JS 컨텍스트가
  // 없음) 둘 다 목적지 URL에 같은 `?signup=1`을 붙이고, 여기 한 곳에서만 발화한다
  // (billing-tab.tsx의 Toss checkout 성공 쿼리파라미터 소비 패턴과 동형 — 처리 直後
  // router.replace로 파라미터를 제거해 새로고침 시 재발화되지 않게 한다).
  useEffect(() => {
    if (!GA_ID || typeof window === 'undefined' || !window.gtag) return;
    if (excluded || isAnalyticsExcluded(pathname ?? '', null, window.location.hash)) return;
    if (searchParams?.get('signup') !== '1') return;
    // once per address: the effect re-runs when `armed` flips while `?signup=1` is still in it (router.replace is not instant)
    const signUpKey = `${pathname}?${searchParams.toString()}`;
    if (signedUp.current === signUpKey) return;
    signedUp.current = signUpKey;
    window.gtag('event', 'sign_up', {
      page_path: pathname,
      page_location: analyticsLocation(window.location.origin, pathname ?? ''),
      page_referrer: lastReferrer.current ?? analyticsReferrer(document.referrer),
    });
    const next = new URLSearchParams(searchParams);
    next.delete('signup');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
    // armed: on a first load the tag is defined only after `armed` — this runs again then, so the conversion is not lost
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, armed, tick]);

  if (!GA_ID || !armed) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}', {
            send_page_view: false,
            page_location: location.origin + location.pathname,
            page_referrer: ${initReferrerExpression()}
          });
        `}
      </Script>
    </>
  );
}

export function GoogleAnalytics() {
  return (
    <Suspense fallback={null}>
      <GoogleAnalyticsInner />
    </Suspense>
  );
}
