import { describe, expect, it } from 'vitest';
import { formatLocaleDateOnly, formatLocaleDateTime, getMessageFallback } from './i18n';

describe('i18n helpers', () => {
  it('returns a deterministic message fallback key', () => {
    expect(getMessageFallback('board', 'title')).toBe('board.title');
  });

  it('formats dates with locale-aware fallback', () => {
    const value = '2026-04-10T12:34:00.000Z';

    expect(formatLocaleDateOnly(value, 'en')).toBeTruthy();
    expect(formatLocaleDateTime(value, 'ko')).toBeTruthy();
    expect(formatLocaleDateOnly(value, 'bad-locale')).toBeTruthy();
  });

  it('returns an empty string for invalid dates', () => {
    expect(formatLocaleDateOnly('not-a-date', 'en')).toBe('');
  });
});
