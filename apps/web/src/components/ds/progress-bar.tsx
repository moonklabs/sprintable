import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ProgressName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };
type ProgressValue =
  | { /** 지금 값(0 이상). NaN · Infinity나 끝 값(`max`)이 숫자가 아니면 «모름»으로 그려진다 — 그때 읽힐 글을 `unavailableLabel`로 줄 수 있다(없으면 값 글 없이 비어 있는 막대로만 읽힌다). */ value: number; unavailableLabel?: string }
  /** 값을 못 구했다 — 막대는 비어 있고 «—»만 보이며 «왜 비었나»는 읽히는 글(`unavailableLabel`)로 필수. 0과 «모름»을 섞지 않는다. */
  | { value: null; unavailableLabel: string };

export type ProgressBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role' | 'aria-label' | 'aria-labelledby' | 'aria-valuenow' | 'aria-valuemin' | 'aria-valuemax' | 'aria-valuetext'> &
  ProgressName &
  ProgressValue & {
    /** 끝 값(보통 한도 · 전체 수). 0보다 커야 비율이 선다. */
    max: number;
    /**
     * `progress` = 진척(목표 «작업 n/m») — 다 차면 `done`. `usage` = 사용량/한도 — 다 차도 `action` 그대로(한도에 닿은 것은 «끝남»이 아니다).
     * 뜻은 색이 아니라 오른쪽 숫자 글과 호출부의 이름이 싣는다.
     */
    tone?: 'progress' | 'usage';
    /** 오른쪽 숫자 칸. 기본 «value/max». `false`면 안 그린다(이름과 값이 다른 곳에 이미 있을 때). */
    valueText?: ReactNode | false;
    /** 스크린리더가 읽는 값 글(예: «12개 중 8개»). 없으면 브라우저가 비율(%)을 읽는다. */
    ariaValueText?: string;
  };

function ratioOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(Math.max(value / max, 0), 1);
}

/**
 * UI-3(a9d56577) ProgressBar — doc v0.3 #23. 높이 4 · 칸 `surface-highest` · 채움 `action`(진척이 다 차면 `done`) · 오른쪽 `mono-md` «n/m» · `role=progressbar` + `aria-valuenow/max`.
 * 이름(`aria-label` | `aria-labelledby`)이 필수다. 채움 너비만 100ms로 움직이고(움직임 줄이기면 즉시) 값은 0~max로 맞춘다.
 */
export function ProgressBar({ value, max, tone = 'progress', valueText, ariaValueText, unavailableLabel, className, ...rest }: ProgressBarProps) {
  // NaN · Infinity도 «모름» — 숫자가 아닌 값을 aria-valuenow="NaN"으로 내보내지 않고, 끝 값이 숫자가 아니면 «5/NaN» 같은 글을 그리지도 읽히지도 않는다(막대 비율과 값 속성 · 글이 갈리지 않게).
  const unavailable = value === null || value === undefined || !Number.isFinite(value) || !Number.isFinite(max);
  const ratio = unavailable ? 0 : ratioOf(value, max);
  const validMax = Number.isFinite(max) && max > 0;
  const complete = !unavailable && validMax && ratio >= 1;
  const showText = valueText !== false;
  const text = unavailable ? '—' : (valueText ?? `${value}/${max}`);
  return (
    <div data-slot="ds-progress" data-unavailable={unavailable || undefined} className={cn('flex items-center gap-2', className)}>
      <div
        {...rest}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={unavailable || !validMax ? undefined : max}
        aria-valuenow={unavailable || !validMax ? undefined : Math.min(Math.max(value, 0), max)}
        aria-valuetext={unavailable ? unavailableLabel : ariaValueText}
        data-slot="ds-progress-track"
        data-complete={complete || undefined}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ds-surface-highest"
      >
        <div
          data-slot="ds-progress-fill"
          className={cn('h-full rounded-full transition-[width] duration-(--ds-duration-fast) motion-reduce:transition-none', complete && tone === 'progress' ? 'bg-ds-done' : 'bg-ds-action')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {showText ? <span data-slot="ds-progress-text" className="shrink-0 font-mono text-ds-mono-md tabular-nums text-ds-ink-3">{text}</span> : null}
    </div>
  );
}
