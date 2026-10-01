'use client';

// story #4443 — the viewer's time zone for everything drawn on this page (lib/viewer-time-zone.ts has the rule).
// - The server passes the zone it read from the `tz` cookie (null on a first visit: it cannot know it yet).
// - In the browser, the page's own zone wins: it is written to the cookie (so the next server render already knows it) and
//   used from then on.
// - While the zone is unknown (a first visit's server render and its hydration), a date is not drawn at all: Yuna 22:45Z — an
//   invisible sample of the same shape holds its width, and a UTC date is never shown «for a moment».
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { VIEWER_TZ_COOKIE, formatViewerDate, runtimeTimeZone } from '@/lib/viewer-time-zone';

// undefined = no provider above (a component rendered on its own, e.g. in a test): the runtime's zone, as before this story
const ViewerTimeZoneContext = createContext<string | null | undefined>(undefined);

const ONE_YEAR_S = 60 * 60 * 24 * 365;

function writeCookie(timeZone: string): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${VIEWER_TZ_COOKIE}=${timeZone}; path=/; max-age=${ONE_YEAR_S}; samesite=lax${secure}`;
  } catch { /* a page that cannot write cookies still draws in the browser's zone */ }
}

// The browser's zone is a value from outside React: read it as one. The server render and hydration use the server's snapshot
// (the cookie's zone · null on a first visit), so the two agree; right after hydration React takes the browser's own.
const noSubscription = () => () => {};

export function ViewerTimeZoneProvider({ serverTimeZone, children }: { serverTimeZone: string | null; children: ReactNode }) {
  const timeZone = useSyncExternalStore(noSubscription, runtimeTimeZone, () => serverTimeZone);
  // the effect only tells the server (the next server render then already knows the zone)
  useEffect(() => {
    const own = runtimeTimeZone();
    if (own && own !== serverTimeZone) writeCookie(own);
  }, [serverTimeZone]);
  return <ViewerTimeZoneContext.Provider value={timeZone}>{children}</ViewerTimeZoneContext.Provider>;
}

/** The viewer's zone, or null while it is not known yet (then draw no date — see InvisibleSample). */
export function useViewerTimeZone(): string | null {
  const tz = useContext(ViewerTimeZoneContext);
  return tz === undefined ? runtimeTimeZone() : tz;
}

/** Holds a date's place while the viewer's zone is unknown: the same shape of text, invisible and hidden from screen readers. */
export function InvisibleSample({ children }: { children: ReactNode }) {
  return <span className="invisible" aria-hidden="true" data-testid="viewer-tz-pending">{children}</span>;
}

/** A «when it happened» drawn for the viewer: their zone and locale; while the zone is unknown, the same shape in an invisible
 *  sample (never a UTC date on screen). The one component the date places use (story #4443 PR2). */
export function ViewerDate({ value, options }: { value: string | number | Date; options: Intl.DateTimeFormatOptions }) {
  const locale = useLocale();
  const tz = useViewerTimeZone();
  // story #4443 PR3a (Kadir 4871 ③ · rule (c)) — a clock time's day period differs between ICU builds (a server's Node «AM 7:18» ·
  // the browser «오전 7:18» — Mirko measured dev's Node 20.20.2 / ICU 78.2): such a time is never drawn in the server render or
  // hydration, only after mount; its place is held by fixed text (the same bytes everywhere, not an Intl result)
  const hasClock = options.hour !== undefined || options.timeStyle !== undefined;
  const mounted = useSyncExternalStore(noSubscription, () => true, () => false);
  const text = hasClock && !mounted ? null : formatViewerDate(value, locale, tz, options);
  if (text !== null) return <>{text}</>;
  return <InvisibleSample>{hasClock ? CLOCK_SAMPLE : formatViewerDate(value, locale, 'UTC', options)}</InvisibleSample>;
}

// the held place of a clock time: fixed text of about its width («오전 7:18» · «7:18 AM»)
const CLOCK_SAMPLE = '00:00 AM';
