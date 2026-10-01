// story #4443 — the viewer's time zone, one rule (PO 22:38Z): when something happened (a message · a disconnect · an activity) is
// drawn in the zone of the person looking at it. The browser knows that zone; the server learns it from the `tz` cookie the
// browser sets (components/viewer-time-zone.tsx). Before this, nothing set a zone: next-intl fell back to the server's own
// (Cloud Run = UTC) and handed it to the browser too, so «연결된 기기» said «9월 30일» on a Korean morning of 10월 1일.
// Server-safe (no DOM): the root layout and i18n/request.ts read the cookie through validTimeZone.

export const VIEWER_TZ_COOKIE = 'tz';

// IANA names only («Asia/Seoul» · «America/Argentina/Buenos_Aires» · «UTC» · «Etc/GMT+9»): letters, digits, «_ + -», up to two «/».
const SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** A zone this runtime can format in, as its canonical name — anything else (empty · too long · not a zone · a cookie someone
 *  typed) is null, never passed on. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !SHAPE.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** This runtime's zone — in the browser, the viewer's. (On the server it is the server's: never call it there for a viewer.) */
export function runtimeTimeZone(): string | null {
  try {
    return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** The calendar day (YYYY-MM-DD) of an instant in a zone — a day separator groups by the viewer's day, not by the UTC one. */
export function dayKeyIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Yuna 22:45Z — a clock time follows the viewer's locale: ko «오전 7:18» · en «7:18 AM» (12-hour, no leading zero on the hour). */
export const VIEWER_TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** A date or time in the viewer's zone and locale — null while the zone is unknown (the caller holds the place, never UTC).
 *  The one place a «when it happened» is formatted (story #4443 PR2); an invalid value is ''. */
export function formatViewerDate(value: string | number | Date, locale: string, timeZone: string | null, options: Intl.DateTimeFormatOptions): string | null {
  if (!timeZone) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone }).format(date);
  }
}
