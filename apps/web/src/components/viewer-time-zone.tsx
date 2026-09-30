'use client';

// story #4443 — the viewer's time zone for everything drawn on this page (lib/viewer-time-zone.ts has the rule).
// - The server passes the zone it read from the `tz` cookie (null on a first visit: it cannot know it yet).
// - In the browser, the page's own zone wins: it is written to the cookie (so the next server render already knows it) and
//   used from then on.
// - While the zone is unknown (a first visit's server render and its hydration), a date is not drawn at all: Yuna 22:45Z — an
//   invisible sample of the same shape holds its width, and a UTC date is never shown «for a moment».
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { VIEWER_TZ_COOKIE, runtimeTimeZone } from '@/lib/viewer-time-zone';

// undefined = no provider above (a component rendered on its own, e.g. in a test): the runtime's zone, as before this story
const ViewerTimeZoneContext = createContext<string | null | undefined>(undefined);

const ONE_YEAR_S = 60 * 60 * 24 * 365;

function writeCookie(timeZone: string): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${VIEWER_TZ_COOKIE}=${timeZone}; path=/; max-age=${ONE_YEAR_S}; samesite=lax${secure}`;
  } catch { /* a page that cannot write cookies still draws in the browser's zone */ }
}

export function ViewerTimeZoneProvider({ serverTimeZone, children }: { serverTimeZone: string | null; children: ReactNode }) {
  const [timeZone, setTimeZone] = useState<string | null>(serverTimeZone);
  useEffect(() => {
    const own = runtimeTimeZone();
    if (!own) return;
    if (own !== serverTimeZone) writeCookie(own);
    setTimeZone(own);
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
