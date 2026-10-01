// @vitest-environment jsdom
//
// story #4443 PR3a — the rule's other two parts (PO 22:38Z): a team's day is the org's zone (the viewer's if the org has none);
// a calendar date (a legal «시행일») has no zone of the reader — the same text for everyone. And /today's «today» is drawn by the
// browser only, after hydration (PO 01:30Z): the server render can't read another instant than the browser (Kadir 4862 second line).
// The process zone is pinned to UTC for this file (a server's zone · no machine-dependent result — PO 22:55Z).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { ViewerDate, ViewerTimeZoneProvider } from './viewer-time-zone';
import { createRoot } from 'react-dom/client';
import { VIEWER_TIME_OPTIONS, shiftDayKey, teamDayKey } from '@/lib/viewer-time-zone';
import { LEGAL_TIME_ZONE, formatLegalDate } from '@/lib/legal-date';
import { formatScheduledAt } from './content/schedule-format';
import { formatRelativeTime } from '@/lib/storage/format';

const { runtimeTz } = vi.hoisted(() => ({ runtimeTz: { value: 'Asia/Seoul' as string | null } }));
vi.mock('@/lib/viewer-time-zone', async (orig) => ({ ...(await orig<typeof import('@/lib/viewer-time-zone')>()), runtimeTimeZone: () => runtimeTz.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/today', useRouter: () => ({ push: vi.fn() }), useParams: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let processTz: string | undefined;
beforeAll(() => { processTz = process.env.TZ; process.env.TZ = 'UTC'; });
afterAll(() => { if (processTz === undefined) delete process.env.TZ; else process.env.TZ = processTz; });
beforeEach(() => { runtimeTz.value = 'Asia/Seoul'; vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: null }) }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); process.env.TZ = 'UTC'; });

// Kadir 4871 ② — no hard-coded Intl text (ICU builds differ): the expected text is the runtime's own Intl with the same locale,
// zone and options, and the numeric parts prove which day the zone gave
const LEGAL_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
const intlText = (iso: string | number, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
const ymdIn = (iso: string | number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return [get('year'), get('month'), get('day')];
};

describe('[SID:4443 PR3a] a team\'s day', () => {
  const at = new Date('2026-09-30T22:39:00Z'); // 07:39 on 10/1 in Seoul · 15:39 on 9/30 in Los Angeles

  it('is the org\'s day (a Seoul org, seen from Los Angeles: 10/1) · the viewer\'s when the org has none · null while neither is known', () => {
    expect(teamDayKey(at, 'Asia/Seoul', 'America/Los_Angeles')).toBe('2026-10-01');
    expect(teamDayKey(at, null, 'America/Los_Angeles')).toBe('2026-09-30');
    expect(teamDayKey(at, 'Not/AZone', 'America/Los_Angeles')).toBe('2026-09-30'); // an org value that is not a zone is ignored
    expect(teamDayKey(at, undefined, null)).toBeNull();
  });

  it('moves by calendar days with no zone in it (across a month, a year, a DST change)', () => {
    expect(shiftDayKey('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2026-03-08', 1)).toBe('2026-03-09'); // US DST starts — a key is a date, not an instant
    expect(shiftDayKey('2026-10-01', 13)).toBe('2026-10-14');
  });
});

describe('[SID:4443 PR3a] a legal «시행일» — Korean law\'s date, the same text for every reader', () => {
  it('a Seoul-midnight start (UTC: the day before at 15:00) reads «2026년 9월 1일» · so does a UTC-midnight start', () => {
    expect(LEGAL_TIME_ZONE).toBe('Asia/Seoul');
    for (const iso of ['2026-08-31T15:00:00Z', '2026-09-01T00:00:00Z']) {
      expect(ymdIn(iso, LEGAL_TIME_ZONE)).toEqual([2026, 9, 1]); // the legal day both times
      expect(formatLegalDate(iso, 'ko')).toBe(intlText(iso, 'ko', LEGAL_TIME_ZONE, LEGAL_OPTS));
      expect(formatLegalDate(iso, 'en')).toBe(intlText(iso, 'en', LEGAL_TIME_ZONE, LEGAL_OPTS));
    }
    expect(formatLegalDate('2026-08-31T15:00:00Z', 'ko')).not.toBe(intlText('2026-08-31T15:00:00Z', 'ko', 'UTC', LEGAL_OPTS)); // not UTC's 8/31
  });

  it('whatever zone the page is drawn in (a Los Angeles process) — the same date, no time, no offset', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatLegalDate('2026-08-31T15:00:00Z', 'ko')).toBe(intlText('2026-08-31T15:00:00Z', 'ko', LEGAL_TIME_ZONE, LEGAL_OPTS));
    expect(formatLegalDate('nope', 'ko')).toBe('');
  });
});

describe('[SID:4443 PR3a] /today\'s «today» is the browser\'s — the server render only holds its place', () => {
  it('rendered on the server at 23:59:59.9 and hydrated just after midnight: no recoverable error, and the browser\'s day (10/1)', async () => {
    const renderedAt = new Date('2026-09-30T14:59:59.900Z').getTime(); // 23:59:59.9 on 9/30 in Seoul
    const { TodayV3Screen } = await import('./today-v3/today-v3-screen');
    const tree = (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <ViewerTimeZoneProvider serverTimeZone="Asia/Seoul"><TodayV3Screen /></ViewerTimeZoneProvider>
      </NextIntlClientProvider>
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(renderedAt));
    const host = document.createElement('div');
    host.innerHTML = renderToString(tree);
    document.body.appendChild(host);
    vi.setSystemTime(new Date('2026-09-30T15:00:00.300Z')); // the browser hydrates just after midnight in Seoul (10/1)
    const recoverable: unknown[] = [];
    let root: Root | null = null;
    await act(async () => { root = hydrateRoot(host, tree, { onRecoverableError: (e) => recoverable.push(e) }); });
    expect(recoverable).toEqual([]);
    const col = host.querySelector('[data-testid="today-v3-today-column"]')!;
    const visible = col.cloneNode(true) as Element;
    visible.querySelectorAll('[data-testid="viewer-tz-pending"]').forEach((n) => n.remove());
    const browserNow = new Date('2026-09-30T15:00:00.300Z'); // the hydration's «now» (10/1 in Seoul)
    expect(ymdIn(browserNow.getTime(), 'Asia/Seoul')).toEqual([2026, 10, 1]);
    expect(visible.textContent).toContain(intlText(browserNow.getTime(), 'ko', 'Asia/Seoul', { month: 'long', day: 'numeric', weekday: 'long' }));
    await act(async () => { root?.unmount(); });
    host.remove();
  });
});

// Kadir 4867 second line ⓐ — the old «same offset as the viewer?» asked the runtime (UTC in a server render). Now the viewer's
// zone is a required argument: the compiler is the guard (a call without it does not build).
describe('[SID:4443 PR3a] the viewer\'s zone is always named for the offset label', () => {
  it('formatScheduledAt · formatRelativeTime need it (a call without it is a type error)', () => {
    // @ts-expect-error — the viewer's zone must be named
    expect(() => formatScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul')).not.toThrow();
    // @ts-expect-error — the viewer's zone must be named
    expect(() => formatRelativeTime('2026-09-30T22:18:00Z', 'ko', 'Asia/Seoul')).not.toThrow();
    // named: an org zone different from the viewer's is labelled; the viewer's own is not — in a UTC process too
    expect(formatScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul', 'America/Los_Angeles').display).toBe('10-01 07:18 GMT+9');
    expect(formatScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul', 'Asia/Seoul').display).toBe('10-01 07:18');
  });
});

// Kadir 4871 ① — the calendar card hands the badge the org's zone: a Seoul org's retry time seen from Los Angeles keeps «GMT+9»
describe('[SID:4443 PR3a] the failure badge labels a zone that is not the viewer\'s', () => {
  async function badgeText(displayTimezone: string): Promise<string> {
    runtimeTz.value = 'America/Los_Angeles';
    const { FailureActionBadge } = await import('./content/failure-action-badge');
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <ViewerTimeZoneProvider serverTimeZone="America/Los_Angeles"><FailureActionBadge action={{ kind: 'auto_retry', nextRetryAt: '2026-09-05T00:00:00Z' } as never} displayTimezone={displayTimezone} /></ViewerTimeZoneProvider>
        </NextIntlClientProvider>,
      );
    });
    const text = host.textContent ?? '';
    await act(async () => { root.unmount(); }); host.remove();
    return text;
  }
  it('the org\'s zone (Seoul) seen from Los Angeles → «… GMT+9» · the viewer\'s own zone → no label', async () => {
    expect(await badgeText('Asia/Seoul')).toContain('GMT+9');
    expect(await badgeText('America/Los_Angeles')).not.toContain('GMT');
  });
});

// Kadir 4871 ③ · rule (c) — a clock time (its day period differs between ICU builds) is never in the server render: fixed text holds
// its place, the time appears after mount
describe('[SID:4443 PR3a] a clock time is drawn after mount only', () => {
  it('server HTML has no time (only the fixed sample, hidden) · after hydration the viewer\'s time · no recoverable error', async () => {
    const iso = '2026-09-30T22:18:00Z';
    const tree = (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <ViewerTimeZoneProvider serverTimeZone="Asia/Seoul"><p data-testid="clock"><ViewerDate value={iso} options={VIEWER_TIME_OPTIONS} /></p></ViewerTimeZoneProvider>
      </NextIntlClientProvider>
    );
    const host = document.createElement('div');
    host.innerHTML = renderToString(tree);
    const pending = host.querySelector('[data-testid="viewer-tz-pending"]');
    expect(pending?.textContent).toBe('00:00 AM'); // fixed bytes — not an Intl result
    const visible = host.cloneNode(true) as Element; visible.querySelectorAll('[data-testid="viewer-tz-pending"]').forEach((n) => n.remove());
    expect(visible.textContent).toBe('');
    document.body.appendChild(host);
    const recoverable: unknown[] = [];
    let root: Root | null = null;
    await act(async () => { root = hydrateRoot(host, tree, { onRecoverableError: (e) => recoverable.push(e) }); });
    expect(recoverable).toEqual([]);
    expect(host.querySelector('[data-testid="clock"]')?.textContent).toBe(intlText(iso, 'ko', 'Asia/Seoul', VIEWER_TIME_OPTIONS));
    await act(async () => { root?.unmount(); }); host.remove();
  });
});
