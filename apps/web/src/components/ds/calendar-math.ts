/**
 * UI-3(a9d56577) 달력 날짜 계산 — `YYYY-MM-DD` 글만 다룬다(UTC 달력 계산: 시간대 · 서머타임에 흔들리지 않는다. DateNav의 `shiftDate`와 같은 방침).
 * 형식이 아니거나 0001~9999년 밖이면 던지지 않고 `null`/원값을 돌려준다(브라우저 날짜 칸이 받는 범위와 같다).
 */
export type Ymd = { y: number; m: number; d: number };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toIso({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** `YYYY-MM-DD` → 값. 실제로 있는 날이 아니면(02-30 …) · 범위 밖이면 null. */
export function parseIso(iso: string): Ymd | null {
  const m = ISO.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  return d <= daysInMonth(y, mo) ? { y, m: mo, d } : null;
}

export function daysInMonth(y: number, m: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m, 0); // m은 1부터 — 다음 달 0일 = 이 달 마지막 날
  return date.getUTCDate();
}

/** 요일(0=일 … 6=토). */
export function weekdayOf({ y, m, d }: Ymd): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCDay();
}

/** 날 수만큼 옮긴다. 0001~9999년 밖으로 나가면 옮기지 않고 그대로. */
export function addDays(iso: string, days: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const date = new Date(0);
  date.setUTCFullYear(p.y, p.m - 1, p.d);
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  if (y < 1 || y > 9999) return iso;
  return toIso({ y, m: date.getUTCMonth() + 1, d: date.getUTCDate() });
}

/** 달 수만큼 옮긴다. 도착 달에 그 날이 없으면 그 달 마지막 날로(1월 31일 +1달 = 2월 말). 범위 밖이면 그대로. */
export function addMonths(iso: string, months: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  if (y < 1 || y > 9999) return iso;
  return toIso({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}

/** 한 주의 시작 요일(0=일 · 1=월)에 맞춰 그 날이 든 주의 첫 날 · 마지막 날. */
export function startOfWeek(iso: string, weekStartsOn: 0 | 1): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return addDays(iso, -((weekdayOf(p) - weekStartsOn + 7) % 7));
}
export function endOfWeek(iso: string, weekStartsOn: 0 | 1): string {
  return addDays(startOfWeek(iso, weekStartsOn), 6);
}

/**
 * 그 달 달력 격자 — 항상 6주 × 7일 = 42칸(앞 · 뒤 달의 날이 채운다). 첫 칸은 `weekStartsOn` 요일.
 * 0001-01 · 9999-12처럼 격자가 표현 범위(0001~9999년) 밖으로 걸치면 그 칸은 `null`(빈 칸) — 날짜를 지어내거나 겹쳐 그리지 않는다.
 */
export function monthGrid(y: number, m: number, weekStartsOn: 0 | 1): Array<string | null> {
  const first = new Date(0);
  first.setUTCFullYear(y, m - 1, 1);
  const lead = (first.getUTCDay() - weekStartsOn + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(first.getTime());
    date.setUTCDate(1 - lead + i);
    const yy = date.getUTCFullYear();
    if (yy < 1 || yy > 9999) return null;
    return toIso({ y: yy, m: date.getUTCMonth() + 1, d: date.getUTCDate() });
  });
}

/** 범위 안으로 맞춘다(`min` · `max`는 `YYYY-MM-DD` — 글 비교가 곧 날짜 비교). */
export function clampIso(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}
