'use client';

import { cn } from '@/lib/utils';
import { Button } from './button';
import { IconButton } from './icon-button';
import { Input } from './input';

/** `YYYY-MM-DD`를 `days`일 옮긴다(UTC 달력 계산 — 시간대 · 서머타임에 흔들리지 않는다). 형식이 아니거나 0001~9999년 밖으로 나가면 그대로 돌려준다. */
export function shiftDate(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  // Date.UTC는 0~99년을 1900~1999로 바꾼다 — 연도는 setUTCFullYear로 넣는다(0001-01-01도 정확히).
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  // 브라우저 날짜 칸은 0001-01-01 ~ 9999-12-31만 받는다 — 그 밖으로 나가면 옮기지 않고 그대로 둔다(0000-12-31 같은 값이 칸을 비워 잠그지 않게).
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return iso;
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface DateNavLabels {
  /** 날짜 칸의 이름 — 필수(예: «날짜»). */
  date: string;
  /** ← 단추의 이름(예: «전날»). 글자가 없는 단추라 이름이 필수다. */
  previousDay: string;
  /** → 단추의 이름(예: «다음날»). */
  nextDay: string;
  /** 오늘로 돌아가는 단추의 글(예: «오늘»). */
  today: string;
}

export interface DateNavProps {
  /** 지금 날짜 `YYYY-MM-DD`. `null`이나 빈 글이면 «아직 모름»(시간대를 아직 몰라 하루를 못 정함) — 옮길 곳이 없으니 칸 · 화살표를 잠근다(«NaN-NaN-NaN»을 만들지 않는다). */
  value: string | null;
  /** 날짜가 바뀔 때 — 화살표는 옮긴 날짜, 칸을 비우면 빈 글(`''` = 모름으로 돌아감, 칸이 비워진 것을 호출부에 그대로 알린다). */
  onChange: (next: string) => void;
  /** 고를 수 있는 가장 이른 · 늦은 날(`YYYY-MM-DD`) — 칸에 그대로 넘기고, 화살표도 그 밖으로 못 간다. */
  min?: string;
  max?: string;
  /** 칸의 step(일 단위). */
  step?: number | string;
  /** «오늘» 단추 — 호출부가 오늘 날짜를 정해 돌린다. */
  onToday: () => void;
  labels: DateNavLabels;
  className?: string;
}

/**
 * UI-3(a9d56577) DateNav — doc v0.3 #25의 «날짜 이동» 줄: ← 전날 · 날짜 칸 · 다음날 → · 오늘. 날짜 칸은 브라우저 기본 `<input type="date">`(달력 · 키보드 · 폰 선택기는 그대로)에 ds `Input` 모양을 입힌 것이다.
 * 화살표는 이름이 있는 IconButton이라 키보드 · 스크린리더 · 터치(폰 44)가 그대로 된다. 달력 팝업을 직접 그리는 판은 후속.
 */
export function DateNav({ value, onChange, onToday, labels, min, max, step, className }: DateNavProps) {
  const locked = !value;
  const prev = value ? shiftDate(value, -1) : null;
  const next = value ? shiftDate(value, 1) : null;
  // 줄은 좁은 화면에서 접힌다(칸 · 화살표 · 오늘이 한 줄에 못 들면 아래로) — 가로로 넘치지 않는다.
  return (
    <div data-slot="ds-date-nav" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <IconButton icon="chevron_left" label={labels.previousDay} disabled={locked || prev === value || (min !== undefined && prev !== null && prev < min)} onClick={() => prev !== null && onChange(prev)} />
      <Input
        type="date"
        aria-label={labels.date}
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
        className="w-auto shrink-0"
      />
      <IconButton icon="chevron_right" label={labels.nextDay} disabled={locked || next === value || (max !== undefined && next !== null && next > max)} onClick={() => next !== null && onChange(next)} />
      <Button type="button" variant="quiet" onClick={onToday} className="shrink-0">
        {labels.today}
      </Button>
    </div>
  );
}
