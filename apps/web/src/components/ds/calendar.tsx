'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { IconButton } from './icon-button';
import { addDays, addMonths, clampIso, daysInMonth, endOfWeek, monthGrid, parseIso, startOfWeek, toIso } from './calendar-math';

export interface CalendarLabels {
  /** ‹ 단추의 이름(예: «이전 달»). 글자가 없는 단추라 이름이 필수다. */
  previousMonth: string;
  /** › 단추의 이름(예: «다음 달»). */
  nextMonth: string;
}

export interface CalendarProps {
  /** 고른 날 `YYYY-MM-DD`. `null`이면 아직 안 골랐다(보이는 달은 «오늘»이 정한다). */
  value: string | null;
  /** 날을 골랐을 때(범위 안의 날만). */
  onChange: (iso: string) => void;
  /** 오늘 `YYYY-MM-DD` — 호출부가 시간대를 알고 정해 넘긴다(이 부품은 `new Date()`를 부르지 않는다: 서버 · 브라우저 시간대가 달라도 흔들리지 않게). */
  today: string;
  /** 고를 수 있는 가장 이른 · 늦은 날. 그 밖의 날은 숨기지 않고 «고를 수 없음»으로 그린다. */
  min?: string;
  max?: string;
  /** 달 · 요일 · 날 이름을 만드는 로케일(예: `ko`). 모르는 값이면 `en`. */
  locale: string;
  /** 한 주의 시작(0 = 일 · 1 = 월). 기본 일요일. */
  weekStartsOn?: 0 | 1;
  labels: CalendarLabels;
  className?: string;
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' });
  }
}
function utcDate(iso: string): Date {
  const p = parseIso(iso)!;
  const d = new Date(0);
  d.setUTCFullYear(p.y, p.m - 1, p.d);
  return d;
}

/**
 * UI-3(a9d56577) Calendar — doc v0.3 #25의 달력. 7×6 칸(칸 32 · 폰 높이 44) · 오늘 = `action` 점 · 고른 날 = `action` 면 · 앞뒤 달의 날은 흐리게.
 * 키보드(ARIA 격자 약속): ←→ 하루 · ↑↓ 한 주 · Home/End 주의 처음/끝 · PageUp/PageDown 한 달(Shift는 한 해) · Enter/Space 고르기. 초점은 한 칸만 탭 순서에 든다(roving).
 * 날짜 칸은 날 전체 이름(예: «2026년 11월 11일 수요일»)을 읽고, 오늘은 `aria-current="date"`, 고른 날은 `aria-selected`. 범위 밖의 날은 `aria-disabled` — 숨기지 않고, 화살표도 그 위에 못 선다.
 * 달 이름은 `aria-live`라 달이 바뀌면 읽힌다. 날짜 계산은 UTC 달력(시간대 · 서머타임에 흔들리지 않는다).
 */
export function Calendar({ value, onChange, today, min, max, locale, weekStartsOn = 0, labels, className }: CalendarProps) {
  const initial = clampIso(parseIso(value ?? '') ? value! : parseIso(today) ? today : '1970-01-01', min, max);
  const [focusIso, setFocusIso] = useState(initial);
  const gridRef = useRef<HTMLTableElement>(null);
  const wantsFocus = useRef(false);
  const gridHadFocus = useRef(false);

  // 밖에서 값 · 범위가 바뀌면(다른 화면 조작) 초점 날도 따라간다 — 효과가 아니라 «렌더 중 이전 값과 비교»로(효과 안 setState는 연쇄 렌더를 부른다).
  const sync = `${value ?? ''}|${min ?? ''}|${max ?? ''}`;
  const [prevSync, setPrevSync] = useState(sync);
  if (sync !== prevSync) {
    setPrevSync(sync);
    setFocusIso(clampIso(value && parseIso(value) ? value : focusIso, min, max));
  }

  // 키보드로 옮긴 뒤에만 실제 초점을 옮긴다(달 단추를 눌러 달이 바뀔 때 초점을 훔치지 않는다).
  // 예외: 격자 안에 초점이 있었는데 밖에서 값 · 범위가 바뀌어 그 칸이 사라졌다면(초점이 문서로 떨어짐) 새 초점 칸으로 옮긴다.
  useEffect(() => {
    const grid = gridRef.current;
    const cellEl = grid?.querySelector<HTMLButtonElement>(`button[data-date="${focusIso}"]`);
    if (wantsFocus.current) {
      wantsFocus.current = false;
      cellEl?.focus();
      return;
    }
    if (gridHadFocus.current && grid && !grid.contains(document.activeElement)) cellEl?.focus();
  }, [focusIso]);

  const focus = parseIso(focusIso) ?? parseIso('1970-01-01')!;
  const cells = useMemo(() => monthGrid(focus.y, focus.m, weekStartsOn), [focus.y, focus.m, weekStartsOn]);
  const monthFmt = useMemo(() => formatter(locale, { year: 'numeric', month: 'long' }), [locale]);
  const dayFmt = useMemo(() => formatter(locale, { dateStyle: 'full' }), [locale]);
  const weekdayShort = useMemo(() => formatter(locale, { weekday: 'short' }), [locale]);
  const weekdayLong = useMemo(() => formatter(locale, { weekday: 'long' }), [locale]);
  const monthLabel = monthFmt.format(utcDate(toIso({ ...focus, d: 1 })));
  // 요일 머리글은 격자와 따로 센다(0001-01 · 9999-12처럼 격자 첫 줄에 빈 칸이 있어도 이름이 틀리지 않게) — 기준 일요일 2023-01-01에서 주 시작만큼.
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays('2023-01-01', weekStartsOn + i);
    return { iso, short: weekdayShort.format(utcDate(iso)), long: weekdayLong.format(utcDate(iso)) };
  });

  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const monthFirst = toIso({ ...focus, d: 1 });
  const monthLast = toIso({ ...focus, d: daysInMonth(focus.y, focus.m) });
  const prevDisabled = !!min && monthFirst <= min;
  const nextDisabled = !!max && monthLast >= max;

  // 키보드 이동(실제 초점도 옮긴다). 달 단추는 위에서 함수형으로 — 연달아 눌러도 오래된 값으로 계산하지 않고, 초점을 훔치지도 않는다.
  const move = (target: string) => {
    const next = clampIso(target, min, max);
    if (next === focusIso) return;
    wantsFocus.current = true;
    setFocusIso(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let target: string | null = null;
    // 오른쪽→왼쪽 글(`dir=rtl`)에서는 화살표 방향이 거꾸로다: ← 가 «다음 날».
    const rtl = (e.currentTarget.closest('[dir]') as HTMLElement | null)?.getAttribute('dir') === 'rtl' || getComputedStyle(e.currentTarget).direction === 'rtl';
    switch (e.key) {
      case 'ArrowLeft': target = addDays(focusIso, rtl ? 1 : -1); break;
      case 'ArrowRight': target = addDays(focusIso, rtl ? -1 : 1); break;
      case 'ArrowUp': target = addDays(focusIso, -7); break;
      case 'ArrowDown': target = addDays(focusIso, 7); break;
      case 'Home': target = startOfWeek(focusIso, weekStartsOn); break;
      case 'End': target = endOfWeek(focusIso, weekStartsOn); break;
      case 'PageUp': target = addMonths(focusIso, e.shiftKey ? -12 : -1); break;
      case 'PageDown': target = addMonths(focusIso, e.shiftKey ? 12 : 1); break;
      default: return;
    }
    e.preventDefault();
    move(target);
  };

  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  return (
    <div data-slot="ds-calendar" className={cn('w-56 max-w-full touch:w-72', className)}>
      <div className="mb-1 flex items-center justify-between">
        <IconButton icon="chevron_left" label={labels.previousMonth} disabled={prevDisabled} onClick={() => setFocusIso((cur) => clampIso(addMonths(cur, -1), min, max))} />
        <div data-slot="ds-calendar-title" aria-live="polite" className="text-ds-card-title font-semibold text-ds-ink">{monthLabel}</div>
        <IconButton icon="chevron_right" label={labels.nextMonth} disabled={nextDisabled} onClick={() => setFocusIso((cur) => clampIso(addMonths(cur, 1), min, max))} />
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-label={monthLabel}
        onKeyDown={onKeyDown}
        onFocus={() => { gridHadFocus.current = true; }}
        onBlur={(e) => { if (e.relatedTarget) gridHadFocus.current = false; }}
        className="w-full table-fixed border-collapse"
      >
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w.iso} scope="col" abbr={w.long} className="h-ds-compact p-0 text-center text-ds-small font-normal text-ds-ink-3">{w.short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((iso, c) => {
                // 표현 범위(0001~9999년) 밖 칸 — 날짜를 지어내지 않고 빈 칸으로 둔다.
                if (!iso) return <td key={`pad-${c}`} role="gridcell" aria-hidden="true" className="p-0" />;
                const p = parseIso(iso)!;
                const selected = iso === value;
                const isToday = iso === today;
                const outside = p.m !== focus.m;
                const disabled = !inRange(iso);
                return (
                  <td key={iso} role="gridcell" aria-selected={selected || undefined} className="p-0 text-center">
                    <Button
                      type="button"
                      variant="quiet"
                      data-date={iso}
                      data-selected={selected || undefined}
                      data-today={isToday || undefined}
                      data-outside={outside || undefined}
                      tabIndex={iso === focusIso ? 0 : -1}
                      aria-label={dayFmt.format(utcDate(iso))}
                      aria-current={isToday ? 'date' : undefined}
                      aria-disabled={disabled || undefined}
                      onClick={() => {
                        if (disabled) return;
                        setFocusIso(iso);
                        onChange(iso);
                      }}
                      // ds Button(조용)이 모양 · 초점 링 · 비활성(aria-disabled = 점선 + ink-3 + 눌림 없음)을 쥔다 — 칸 모양만 덮는다: 32 정사각(폰은 높이 44 · 열 너비) · 글 굵기 보통.
                      className={cn(
                        'relative mx-auto h-ds-compact w-ds-compact min-w-0 px-0 text-ds-body font-normal tabular-nums focus-visible:ring-inset focus-visible:ring-offset-0 touch:h-ds-touch touch:w-full touch:min-w-0',
                        outside ? 'text-ds-ink-3' : 'text-ds-ink',
                        disabled && 'line-through',
                        selected && 'bg-ds-action font-semibold text-ds-on-action hover:bg-ds-action hover:text-ds-on-action',
                        // 오늘 점: 숫자 아래 작은 점(색만이 아닌 «모양» + aria-current). 고른 날 위에서는 면 위 글자색.
                        isToday && 'after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:content-[""]',
                        isToday && (selected ? 'after:bg-ds-on-action' : 'after:bg-ds-action'),
                      )}
                    >
                      {p.d}
                    </Button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
