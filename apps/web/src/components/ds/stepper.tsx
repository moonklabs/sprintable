import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export type StepperStep = {
  /** 목록 key — 단계끼리 달라야 한다. */
  id: string | number;
  /** 단계 이름 — 점 아래에 그대로 보인다(한 줄이 모자라면 줄바꿈). */
  label: string;
};

type StepperName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export type StepperProps = Omit<HTMLAttributes<HTMLOListElement>, 'children' | 'aria-label' | 'aria-labelledby'> &
  StepperName & {
    steps: readonly StepperStep[];
    /** 지금 단계의 자리(0부터). `steps.length`면 모두 끝난 것. 범위 밖은 가장자리로(±Infinity 포함), 숫자가 아닌 값(NaN)은 0으로 맞춘다. */
    current: number;
    /** 단계 상태를 읽는 글 — 필수. 점 모양(체크 · 링 · 속 빈 점)은 보는 사람의 뜻이고 스크린리더는 이 글을 읽는다. */
    stateLabels: { done: string; current: string; upcoming: string };
  };

function clampCurrent(current: number, length: number): number {
  if (Number.isNaN(current)) return 0;
  return Math.min(Math.max(0, Math.trunc(current)), length);
}

/**
 * UI-3(a9d56577) Stepper — doc v0.3 #24. 가로로 늘어선 단계 점 + 이은 선 + 점 아래 단계 이름.
 * 끝 = `done` 체크 · 지금 = `action` 링 + 번호 · 아직 = 속 빈 점 + 번호 — 색만으로 말하지 않는다(체크 · 링 · 번호 + 보이지 않는 상태 글).
 * 단계는 같은 폭으로 나눠 가진다(5개가 390폭에 들어간다). 「막힘」 상태는 없다 — 현행 채용 화면 머리에도 없는 것이라 더하지 않았다(새 기능 0).
 * 눌리는 부품이 아니다: 단계 이동 · 검증 목록(VerifyRail)은 이 부품의 일이 아니다.
 */
export function Stepper({ steps, current, stateLabels, className, ...rest }: StepperProps) {
  const at = clampCurrent(current, steps.length);
  return (
    <ol {...rest} data-slot="ds-stepper" className={cn('m-0 flex w-full list-none items-start p-0', className)}>
      {steps.map((step, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'upcoming';
        return (
          <li
            key={step.id}
            data-slot="ds-stepper-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cn(
              'relative flex min-w-0 flex-1 basis-0 flex-col items-center gap-1 text-center',
              // 앞 단계 점 가운데 → 이 점 가운데로 잇는 선(논리 방향 start/end — 오른쪽→왼쪽 글에서도 앞 단계 쪽으로 뻗는다) — 앞 단계가 끝났으면 done 색.
              i > 0 && 'before:absolute before:top-3 before:end-1/2 before:start-[-50%] before:h-0.5 before:-translate-y-1/2 before:rounded-full',
              i > 0 && (i <= at ? 'before:bg-ds-done' : 'before:bg-ds-line-control'),
            )}
          >
            <span
              aria-hidden="true"
              data-slot="ds-stepper-dot"
              className={cn(
                'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 font-mono text-ds-mono-md',
                state === 'done' && 'border-ds-done bg-ds-done-soft text-ds-done',
                state === 'current' && 'border-ds-action bg-ds-surface text-ds-ink',
                state === 'upcoming' && 'border-ds-line-control bg-ds-surface text-ds-ink-3',
              )}
            >
              {state === 'done' ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span
              data-slot="ds-stepper-label"
              className={cn('max-w-full px-0.5 text-ds-small break-keep wrap-anywhere', state === 'current' ? 'font-semibold text-ds-ink' : state === 'done' ? 'text-ds-ink-2' : 'text-ds-ink-3')}
            >
              <span className="sr-only">{stateLabels[state]} </span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
