// story #4443 PR2b — every «when it happened» that went through resolveDisplayTimezone() (the runtime's zone) now takes the
// viewer's (useViewerTimeZone · null until known). The two shared formatters are the one place that null is handled: a date is
// not drawn while the zone is unknown (never the server's UTC); a relative time needs no zone and is drawn as before.
// The process zone is pinned to UTC for this file (no machine-dependent result — PO 22:55Z).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatScheduledAt, formatViewerScheduledAt } from './content/schedule-format';
import { formatDate, formatRelativeTime, formatViewerRelativeTime } from '@/lib/storage/format';

let processTz: string | undefined;
beforeAll(() => { processTz = process.env.TZ; process.env.TZ = 'UTC'; });
afterAll(() => { if (processTz === undefined) delete process.env.TZ; else process.env.TZ = processTz; });
afterEach(() => { vi.useRealTimers(); });

describe('[SID:4443 PR2b] the shared formatters with the viewer\'s zone', () => {
  it('formatScheduledAt: the viewer\'s zone → its time · not known yet → nothing (was: the runtime\'s zone, UTC on a server)', () => {
    expect(formatScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul', 'Asia/Seoul').display).toBe('10-01 07:18');
    expect(formatScheduledAt('2026-09-30T22:18:00Z', null)).toEqual({ display: '', utcNote: '' });
  });

  it('formatRelativeTime: within a week no zone is needed («3시간 전») · past a week it is a date in the viewer\'s zone, or nothing yet', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T01:18:00Z'));
    expect(formatRelativeTime('2026-09-30T22:18:00Z', 'ko', null)).toBe('3시간 전');
    expect(formatViewerRelativeTime('2026-09-20T22:18:00Z', 'ko', 'Asia/Seoul')).toBe('09-21 07:18');
    expect(formatViewerRelativeTime('2026-09-20T22:18:00Z', 'ko', null)).toBe('');
  });

  // a server render (this process is UTC) of a Seoul viewer's page: their own zone carries no offset label — asked of the runtime,
  // the old default said «GMT+9» on the server and nothing in the browser (a text mismatch at hydration)
  it('the viewer\'s own zone is never labelled, even where the runtime is UTC (a server render)', () => {
    expect(formatViewerScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul').display).toBe('10-01 07:18');
    expect(formatScheduledAt('2026-09-30T22:18:00Z', 'Asia/Seoul').display).toBe('10-01 07:18 GMT+9'); // runtime compared (org-zone callers · PR3)
  });

  it('formatDate (storage meta): the viewer\'s day · not known yet → no day (never the UTC one)', () => {
    expect(formatDate('2026-09-30T22:18:00Z', 'Asia/Seoul')).toBe('2026-10-01');
    expect(formatDate('2026-09-30T22:18:00Z', null)).toBe('');
  });
});
