import { describe, expect, it } from 'vitest';
import { formatDayHeader, groupByDay } from './group-by-day';

const row = (id: string, created_at: string) => ({ id, created_at });
const NOW = new Date('2026-11-10T15:30:00Z'); // 2026-11-11 00:30 in Asia/Seoul · 2026-11-10 in UTC

describe('groupByDay (4892)', () => {
  it('⭐groups newest-first rows by the zone\'s calendar day with today / yesterday / date kinds', () => {
    const rows = [row('a', '2026-11-10T16:00:00Z'), row('b', '2026-11-10T14:00:00Z'), row('c', '2026-11-09T01:00:00Z'), row('d', '2026-11-05T01:00:00Z')];
    const groups = groupByDay(rows, 'Asia/Seoul', NOW);
    // Seoul: a = 11-11 01:00 (today) · b = 11-10 23:00 (yesterday) · c = 11-09 10:00 · d = 11-05
    expect(groups.map((g) => [g.key, g.kind, g.items.map((i) => i.id)])).toEqual([
      ['2026-11-11', 'today', ['a']],
      ['2026-11-10', 'yesterday', ['b']],
      ['2026-11-09', 'date', ['c']],
      ['2026-11-05', 'date', ['d']],
    ]);
  });

  it('the same instant is a different day in a different zone (the viewer\'s zone decides)', () => {
    const rows = [row('a', '2026-11-10T16:00:00Z')];
    expect(groupByDay(rows, 'UTC', NOW).map((g) => [g.key, g.kind])).toEqual([['2026-11-10', 'today']]);
    expect(groupByDay(rows, 'Asia/Seoul', NOW).map((g) => [g.key, g.kind])).toEqual([['2026-11-11', 'today']]);
  });

  it('keeps the incoming order inside a day and never splits a day in two', () => {
    const rows = [row('a', '2026-11-10T10:00:00Z'), row('b', '2026-11-10T09:00:00Z'), row('c', '2026-11-10T08:00:00Z')];
    const groups = groupByDay(rows, 'UTC', NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('⭐a row at exactly local midnight belongs to the NEW day, one second earlier to the day before', () => {
    const rows = [row('a', '2026-11-09T15:00:00Z'), row('b', '2026-11-09T14:59:59Z')];   // Seoul: 11-10 00:00:00 and 11-09 23:59:59
    expect(groupByDay(rows, 'Asia/Seoul', new Date('2026-11-10T03:00:00Z')).map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['2026-11-10', ['a']],
      ['2026-11-09', ['b']],
    ]);
  });

  it('no rows → no groups (no empty headers)', () => {
    expect(groupByDay([], 'UTC', NOW)).toEqual([]);
  });

  it('formats a date header in the locale (the weekday and the day are the zone\'s calendar day)', () => {
    expect(formatDayHeader('2026-11-09', 'ko')).toContain('9일');
    expect(formatDayHeader('2026-11-09', 'en')).toContain('November');
    expect(formatDayHeader('2026-11-09', 'en')).toContain('Mon');
  });
});
