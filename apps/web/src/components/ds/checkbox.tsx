'use client';

import { useId, type ReactNode } from 'react';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, 'className' | 'children'> & {
  className?: string;
  /** 보이는 이름이 필수다 — 색만으로 «무엇의 체크인지» 말하지 않는다. */
  label: ReactNode;
};

/**
 * UI-3(a9d56577) Checkbox — doc v0.3 #22. 16px · 경계 `line-control`(3:1) · 켬 = `action` 면 + 체크 / 일부 = 가로선(색만으로 안 읽힘) · 초점 링 · 비활성 = 점선 + `ink-3`.
 * 키보드는 날것 checkbox와 같다: 스페이스로만 켜고 끈다(Base UI는 span 뿌리라 엔터도 «누름»으로 처리해 켜 버리므로 엔터는 건너뛴다 — 현행 `ui/checkbox`와 같은 약속).
 * 누름 영역은 이름까지 포함한 줄 전체(최소 높이 28 · 폰 44).
 */
export function Checkbox({ label, className, onKeyDown, ...props }: CheckboxProps) {
  // Base UI 뿌리는 span role=checkbox라 감싼 <label>이 이름을 주지 못한다(axe aria-toggle-field-name) — 이름 글에 id를 달아 뿌리가 aria-labelledby로 가리킨다.
  const labelId = useId();
  return (
    <label data-slot="ds-checkbox-field" className={cn('inline-flex min-h-7 cursor-pointer items-center gap-2 text-ds-body text-ds-ink touch:min-h-11 has-data-disabled:cursor-not-allowed has-data-disabled:text-ds-ink-3', className)}>
      <CheckboxPrimitive.Root
        data-slot="ds-checkbox"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === 'Enter') event.preventBaseUIHandler();
        }}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-ds-tag border border-ds-line-control bg-ds-surface-sunk text-ds-on-action outline-none focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background data-checked:border-ds-action data-checked:bg-ds-action data-indeterminate:border-ds-action data-indeterminate:bg-ds-action data-disabled:cursor-not-allowed data-disabled:border-dashed data-disabled:bg-transparent data-disabled:text-ds-ink-3 data-disabled:data-checked:border-ds-line-control data-disabled:data-checked:bg-transparent data-disabled:data-indeterminate:border-ds-line-control data-disabled:data-indeterminate:bg-transparent aria-invalid:border-ds-failed"
        {...props}
      >
        <CheckboxPrimitive.Indicator data-slot="ds-checkbox-indicator" className="flex items-center justify-center" render={(p, state) => <span {...p}>{state.indeterminate ? <Icon name="remove" size={12} /> : <Icon name="check" size={12} />}</span>} />
      </CheckboxPrimitive.Root>
      <span id={labelId}>{label}</span>
    </label>
  );
}
