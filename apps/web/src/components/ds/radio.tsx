'use client';

import { useId, type ReactNode } from 'react';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '@/lib/utils';
import { DATA_DISABLED_FACE } from './disabled-face';

/** 묶음의 접근성 이름이 필수다(보이는 제목 id를 `aria-labelledby`로, 없으면 `aria-label`) — 이름 없는 radiogroup은 스크린리더가 «무엇을 고르는지» 알 수 없다. */
type RadioGroupName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export type RadioGroupProps = Omit<RadioGroupPrimitive.Props, 'className' | 'aria-label' | 'aria-labelledby'> & { className?: string } & RadioGroupName;

/** UI-3(a9d56577) RadioGroup — 화살표 키 이동과 «한 번에 하나 선택»을 묶음이 맡는다(현행 `ui/radio-group`과 같은 약속). */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  return <RadioGroupPrimitive data-slot="ds-radio-group" className={cn('flex flex-col gap-1', className)} {...props} />;
}

export type RadioProps = Omit<RadioPrimitive.Root.Props, 'className' | 'children'> & {
  className?: string;
  /** 보이는 이름이 필수다. */
  label: ReactNode;
};

/**
 * UI-3(a9d56577) Radio — doc v0.3 #22. 16px 원 · 경계 `line-control` · 고름 = `action` 테두리 + 안쪽 점 · 초점 링 · 비활성 = 점선 + `ink-3`.
 * 키보드: 초점 있는 항목에서 스페이스가 그 항목을 고른다. Base UI 1.3.0은 스페이스 keydown에서 preventDefault 뒤 onClick을 불러 «defaultPrevented면 무시»로 아무것도 못 고르므로,
 * 부품이 스페이스를 직접 받아 진짜 클릭을 한 번 일으킨다(현행 `ui/radio-group`과 같은 처리).
 */
export function Radio({ label, className, onKeyDown, ...props }: RadioProps) {
  // 뿌리(span role=radio)는 감싼 <label>로 이름을 못 받는다 — 이름 글 id를 aria-labelledby로 가리킨다.
  const labelId = useId();
  return (
    <label data-slot="ds-radio-field" className={cn('inline-flex min-h-ds-control-sm cursor-pointer items-center gap-2 text-ds-body text-ds-ink touch:min-h-ds-touch has-data-disabled:cursor-not-allowed has-data-disabled:text-ds-ink-3', className)}>
      <RadioPrimitive.Root
        data-slot="ds-radio"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === ' ' && !event.defaultPrevented) {
            event.preventDefault();
            event.preventBaseUIHandler();
            event.currentTarget.click();
          }
        }}
        className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-ds-line-control bg-ds-surface-sunk outline-none focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background data-checked:border-ds-action data-disabled:cursor-not-allowed ${DATA_DISABLED_FACE} aria-invalid:border-ds-failed data-disabled:aria-invalid:border-ds-failed data-disabled:data-checked:aria-invalid:border-ds-failed`}
        {...props}
      >
        <RadioPrimitive.Indicator data-slot="ds-radio-indicator" className="size-2 rounded-full bg-ds-action data-disabled:bg-ds-ink-3" />
      </RadioPrimitive.Root>
      <span id={labelId}>{label}</span>
    </label>
  );
}
