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
