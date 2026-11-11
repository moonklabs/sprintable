'use client';

import { useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';
import { Calendar, type CalendarLabels } from './calendar';
import { Icon } from './icon';
import { parseIso, toIso } from './calendar-math';

export interface DatePickerLabels extends CalendarLabels {
  /** 트리거(날짜 칸)의 이름 — 필수(예: «시작일»). 팝업의 이름도 같다. */
  date: string;
  /** 값이 없을 때 칸에 보이는 글(예: «날짜 고르기»). */
  placeholder: string;
}

export interface DatePickerProps {
  /** 고른 날 `YYYY-MM-DD` · 없으면 `null`. */
  value: string | null;
  onChange: (iso: string) => void;
  /** 오늘 `YYYY-MM-DD` — 호출부가 시간대를 알고 정해 넘긴다(`Calendar`와 같다). */
  today: string;
  min?: string;
  max?: string;
  locale: string;
  weekStartsOn?: 0 | 1;
  labels: DatePickerLabels;
  disabled?: boolean;
  /** 칸의 오류(`aria-invalid`) — 보이는 글과 아이콘은 `Field`가 붙인다. */
  invalid?: boolean;
  className?: string;
}

function formatValue(value: string | null, locale: string): string | null {
  const p = value ? parseIso(value) : null;
  if (!p) return null;
  const d = new Date(0);
  d.setUTCFullYear(p.y, p.m - 1, p.d);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  } catch {
    return toIso(p);
  }
}

/**
 * UI-3(a9d56577) DatePicker — doc v0.3 #25. 날짜 칸 모양(높이 36 · 폰 44 — `Input`과 같은 경계 · 초점)의 트리거를 누르면 `Calendar`가 Menu 규격 팝업으로 열린다.
 * 날을 고르면 값을 알리고 팝업을 닫아 초점이 트리거로 돌아온다. 열고 닫기 · 바깥 눌러 닫기 · Esc · 초점 복원은 Base UI 몫이다.
 * 눌리는 «칸»이라 브라우저 기본 날짜 칸(`<input type=date>`, DateNav가 쓰는 것)을 대신하는 것이 아니다 — 쓰는 화면이 고른다.
 */
export function DatePicker({ value, onChange, today, min, max, locale, weekStartsOn, labels, disabled, invalid, className }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => formatValue(value, locale), [value, locale]);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        data-slot="ds-date-picker"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-ds-control w-full min-w-0 items-center justify-between gap-2 rounded-ds-control border border-ds-line-control bg-ds-surface-sunk px-3 text-left text-base text-ds-ink outline-none transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none lg:text-ds-body touch:h-ds-touch',
          'focus-visible:border-ds-action focus-visible:ring-2 focus-visible:ring-ds-action',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:text-ds-ink-3',
          'aria-invalid:border-ds-failed aria-invalid:focus-visible:ring-ds-failed',
          className,
        )}
      >
        {/* 이름(필드 이름)과 값을 함께 읽는다 — aria-label이면 보이는 값을 덮어 고른 날이 안 읽혔다. */}
        <span className="sr-only">{labels.date} </span>
        <span className={cn('min-w-0 truncate', shown ? 'text-ds-ink' : 'text-ds-ink-3')}>{shown ?? labels.placeholder}</span>
        <Icon name="calendar_month" className="shrink-0 text-ds-ink-3" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner className="isolate z-50 outline-none" align="start" sideOffset={4}>
          <PopoverPrimitive.Popup
            ref={popupRef}
            // 열면 초점이 «이전 달» 단추가 아니라 날짜 격자의 초점 칸으로 간다(방향키가 바로 먹는다).
            initialFocus={() => popupRef.current?.querySelector<HTMLElement>('button[data-date][tabindex="0"]') ?? true}
            data-slot="ds-date-picker-popup"
            aria-label={labels.date}
            className="z-50 max-w-[calc(100vw-1rem)] origin-(--transform-origin) rounded-ds-panel border border-ds-line-control bg-ds-surface-raised p-2 text-ds-ink shadow-ds-popup outline-none duration-(--ds-duration-fast) motion-reduce:duration-(--ds-duration-instant) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          >
            <Calendar
              value={value}
              today={today}
              min={min}
              max={max}
              locale={locale}
              weekStartsOn={weekStartsOn}
              labels={{ previousMonth: labels.previousMonth, nextMonth: labels.nextMonth }}
              onChange={(iso) => {
                onChange(iso);
                setOpen(false);
              }}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
