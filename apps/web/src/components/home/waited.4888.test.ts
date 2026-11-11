// story #4888(UI-5 홈) — «기다린 시간»: 분 → 시간 → 일. 미래 · 날짜가 아닌 값은 음수나 NaN 대신 «방금».
import { describe, expect, it } from 'vitest';
import { waitedSince } from './waited';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN;

describe('waitedSince', () => {
  it('⭐1분 미만은 «방금» · 1분부터 분 단위(59분까지)', () => {
    expect(waitedSince(ago(0), NOW)).toEqual({ unit: 'now', count: 0 });
    expect(waitedSince(ago(59_999), NOW)).toEqual({ unit: 'now', count: 0 });
    expect(waitedSince(ago(MIN), NOW)).toEqual({ unit: 'minutes', count: 1 });
    expect(waitedSince(ago(59 * MIN + 59_000), NOW)).toEqual({ unit: 'minutes', count: 59 });
  });
  it('⭐60분부터 시간 단위(47시간까지) · 48시간부터 일 단위', () => {
    expect(waitedSince(ago(60 * MIN), NOW)).toEqual({ unit: 'hours', count: 1 });
    expect(waitedSince(ago(47 * HOUR + 59 * MIN), NOW)).toEqual({ unit: 'hours', count: 47 });
    expect(waitedSince(ago(48 * HOUR), NOW)).toEqual({ unit: 'days', count: 2 });
    expect(waitedSince(ago(80 * HOUR), NOW)).toEqual({ unit: 'days', count: 3 });
  });
  it('⭐미래 시각 · 날짜가 아닌 값은 «방금»(음수 · NaN을 찍지 않는다)', () => {
    expect(waitedSince(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toEqual({ unit: 'now', count: 0 });
    expect(waitedSince('not-a-date', NOW)).toEqual({ unit: 'now', count: 0 });
    expect(waitedSince('', NOW)).toEqual({ unit: 'now', count: 0 });
  });
});
