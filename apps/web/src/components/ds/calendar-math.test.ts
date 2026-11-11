// UI-3(a9d56577) — 달력 날짜 계산 회귀가드: 윤년 · 달 끝 · 연말 · 주 시작 · 42칸 격자 · 범위 밖(0001/9999) · 잘못된 글.
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, clampIso, daysInMonth, endOfWeek, monthGrid, parseIso, startOfWeek, toIso, weekdayOf } from './calendar-math';

describe('parseIso / toIso', () => {
  it('⭐실제 있는 날만: 02-30 · 13월 · 0일 · 형식 틀림은 null', () => {
    expect(parseIso('2026-11-11')).toEqual({ y: 2026, m: 11, d: 11 });
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', '', 'abc', '0000-01-01', '2026-11-11T00:00']) expect(parseIso(bad), bad).toBeNull();
    expect(parseIso('2024-02-29')).not.toBeNull(); // 윤년
    expect(parseIso('2026-02-29')).toBeNull(); // 평년
    expect(parseIso('1900-02-29')).toBeNull(); // 100의 배수 평년
    expect(parseIso('2000-02-29')).not.toBeNull(); // 400의 배수 윤년
  });
  it('toIso는 0001년도 4자리로', () => {
    expect(toIso({ y: 1, m: 2, d: 3 })).toBe('0001-02-03');
  });
});

describe('daysInMonth / weekdayOf', () => {
  it('달 길이', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
  it('요일(0=일): 2026-11-11은 수요일', () => {
    expect(weekdayOf({ y: 2026, m: 11, d: 11 })).toBe(3);
    expect(weekdayOf({ y: 2026, m: 11, d: 8 })).toBe(0);
  });
});

describe('addDays', () => {
  it('⭐달 · 연 경계와 윤년을 넘는다', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-11-11', 0)).toBe('2026-11-11');
    expect(addDays('2026-11-11', 7)).toBe('2026-11-18');
  });
  it('범위 밖(0001 이전 · 9999 이후)이면 그대로 · 잘못된 글도 그대로', () => {
    expect(addDays('0001-01-01', -1)).toBe('0001-01-01');
    expect(addDays('9999-12-31', 1)).toBe('9999-12-31');
    expect(addDays('nope', 3)).toBe('nope');
  });
});

describe('addMonths', () => {
  it('⭐도착 달에 그 날이 없으면 그 달 마지막 날로', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-05-31', 1)).toBe('2026-06-30');
  });
  it('연을 넘는다(앞 · 뒤)', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
  });
  it('범위 밖이면 그대로', () => {
    expect(addMonths('0001-01-15', -1)).toBe('0001-01-15');
    expect(addMonths('9999-12-15', 1)).toBe('9999-12-15');
  });
});

describe('startOfWeek / endOfWeek', () => {
  it('일요일 시작: 수요일 2026-11-11 → 11-08 ~ 11-14', () => {
    expect(startOfWeek('2026-11-11', 0)).toBe('2026-11-08');
    expect(endOfWeek('2026-11-11', 0)).toBe('2026-11-14');
  });
  it('월요일 시작: 같은 날 → 11-09 ~ 11-15 · 일요일은 앞 주의 끝', () => {
    expect(startOfWeek('2026-11-11', 1)).toBe('2026-11-09');
    expect(endOfWeek('2026-11-11', 1)).toBe('2026-11-15');
    expect(startOfWeek('2026-11-08', 1)).toBe('2026-11-02');
  });
});

describe('monthGrid', () => {
  it('⭐항상 42칸 · 첫 칸은 주 시작 요일 · 그 달 1일과 말일이 들어 있다', () => {
    for (const [y, m] of [[2026, 11], [2026, 2], [2024, 2], [2026, 8], [2027, 1]] as const) {
      for (const ws of [0, 1] as const) {
        const g = monthGrid(y, m, ws) as string[];
        expect(g.length).toBe(42);
        expect(weekdayOf(parseIso(g[0]!)!)).toBe(ws);
        expect(g).toContain(toIso({ y, m, d: 1 }));
        expect(g).toContain(toIso({ y, m, d: daysInMonth(y, m) }));
        expect(new Set(g).size).toBe(42);
        expect([...g].sort()).toEqual(g); // 날짜순
      }
    }
  });
  it('⭐표현 범위 끝: 0001-01은 앞 칸이 빈 칸(null) · 9999-12는 뒤 칸이 빈 칸 — 날짜를 지어내거나 겹쳐 그리지 않는다', () => {
    const g = monthGrid(1, 1, 0); // 0001-01-01은 월요일 → 일요일 칸은 0000년이라 null
    expect(g.length).toBe(42);
    expect(g[0]).toBeNull();
    expect(g[1]).toBe('0001-01-01');
    expect(weekdayOf(parseIso(g[1]!)!)).toBe(1);
    const real = g.filter((x): x is string => x !== null);
    expect(new Set(real).size).toBe(real.length);
    expect([...real].sort()).toEqual(real);
    const h = monthGrid(9999, 12, 0); // 9999-12-31은 금요일 → 토요일 칸부터 10000년이라 null
    expect(h.length).toBe(42);
    expect(h).toContain('9999-12-31');
    expect(h[h.indexOf('9999-12-31') + 1]).toBeNull();
    expect(h[41]).toBeNull();
    const hreal = h.filter((x): x is string => x !== null);
    expect(new Set(hreal).size).toBe(hreal.length);
  });

  it('2026-11 일요일 시작: 첫 칸 11-01(일) · 마지막 칸 12-12', () => {
    const g = monthGrid(2026, 11, 0);
    expect(g[0]).toBe('2026-11-01');
    expect(g[41]).toBe('2026-12-12');
  });
});

describe('clampIso', () => {
  it('범위 안으로 맞춘다', () => {
    expect(clampIso('2026-11-11', '2026-11-12', '2026-11-20')).toBe('2026-11-12');
    expect(clampIso('2026-11-30', '2026-11-12', '2026-11-20')).toBe('2026-11-20');
    expect(clampIso('2026-11-15', '2026-11-12', '2026-11-20')).toBe('2026-11-15');
    expect(clampIso('2026-11-15')).toBe('2026-11-15');
  });
});
