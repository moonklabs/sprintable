// story #4443 — the viewer's time zone, one rule (PO 22:38Z): when something happened (a message · a disconnect · an activity) is
// drawn in the zone of the person looking at it. The browser knows that zone; the server learns it from the `tz` cookie the
// browser sets (components/viewer-time-zone.tsx). Before this, nothing set a zone: next-intl fell back to the server's own
// (Cloud Run = UTC) and handed it to the browser too, so «연결된 기기» said «9월 30일» on a Korean morning of 10월 1일.
// Server-safe (no DOM): the root layout and i18n/request.ts read the cookie through validTimeZone.
//
// Rule (story #4449 · PO 03:38Z): a clock time with a day period — ko «오전/오후», en «AM/PM», i.e. anything drawn with
// VIEWER_TIME_OPTIONS or `hour: 'numeric'` — is drawn after mount only, never into the server's HTML. Its words come from the
// runtime's ICU, and runtimes disagree: ICU 78.2 (Node 20.20.2 · 22.23.2) says ko «AM 7:18», 78.3 (Node 22.23.3) and
// Chrome say «오전 7:18», and Safari carries its own ICU. Pinning the server's Node to CI's (apps/web/Dockerfile ·
// verify:node-version-matches-ci) makes the server agree with our tests, not with every browser — so a server-drawn day period
// would be a hydration text mismatch for some viewers. Dates without a day period («10월 1일 목요일») and 24-hour times are
// the same across these ICUs. Today no server HTML carries one (dev, 2026-10-01: org-briefing · inbox · chats · workforce ·
// events · activity · desktop/setup — 0).

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

/** story #4443 PR3a — a team's calendar day (YYYY-MM-DD: the standup day, a sprint's day) is the org's (PO 22:38Z ①), the
 *  viewer's when the org has set none; null while neither is known (draw/fetch nothing yet — never the runtime's). */
export function teamDayKey(now: Date, orgTimeZone: string | null | undefined, viewerTimeZone: string | null): string | null {
  const tz = validTimeZone(orgTimeZone) ?? viewerTimeZone;
  return tz ? dayKeyIn(now.toISOString(), tz) : null;
}

/** A day key moved by whole calendar days — date arithmetic with no zone in it (a key is a calendar date, not an instant). */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days)); // UTC fields only: calendar arithmetic, not a zone
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
