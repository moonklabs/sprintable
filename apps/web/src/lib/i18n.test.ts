import { describe, expect, it } from 'vitest';
import { formatLocaleDate, formatLocaleDateOnly, formatLocaleDateTime } from './i18n';

describe('i18n helpers', () => {
  it('formats dates with locale-aware fallback', () => {
    const value = '2026-04-10T12:34:00.000Z';

    expect(formatLocaleDateOnly(value, 'en', 'UTC')).toBeTruthy();
    expect(formatLocaleDateTime(value, 'ko', 'UTC')).toBeTruthy();
    expect(formatLocaleDateOnly(value, 'bad-locale', 'UTC')).toBeTruthy();
  });

  it('returns an empty string for invalid dates', () => {
    expect(formatLocaleDateOnly('not-a-date', 'en', 'UTC')).toBe('');
  });

  // story #4443 PR2 — the zone the caller names, not the runtime's: 22:32Z on 9/30 is 10/1 in Seoul whatever machine runs this
  it('draws in the zone it is given', () => {
    expect(formatLocaleDate('2026-09-30T22:32:00Z', 'ko', { month: 'long', day: 'numeric' }, 'Asia/Seoul')).toBe('10월 1일');
    expect(formatLocaleDate('2026-09-30T22:32:00Z', 'ko', { month: 'long', day: 'numeric' }, 'UTC')).toBe('9월 30일');
  });
});
