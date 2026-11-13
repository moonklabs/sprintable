'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { DATA_DISABLED_FACE } from './disabled-face';

export type ToggleProps = Omit<SwitchPrimitive.Root.Props, 'className' | 'children'> & {
  className?: string;
  /** 무엇을 켜고 끄는지 — 필수. */
  label: string;
  /** 켜짐 / 꺼짐을 글로도 보인다(색 · 위치만으로 읽지 않는다). 예: «켬» / «끔». */
  onText: string;
  offText: string;
};

/**
 * UI-3(a9d56577) Toggle — doc v0.3 #22. 트랙 28×16 · 꺼짐 = `line-control` 윤곽 · 켜짐 = `action` 면 · 상태를 **글**(`onText` / `offText`)로도 보인다 · 초점 링 · 비활성 = 점선 + `ink-3`.
 * 이름(`label`)과 상태 글이 필수라 색만으로 켜짐을 말하지 않는다. 상태 글은 **눈에 보이는 용도**라 `aria-hidden`이다 — 스크린리더는 `role=switch`의 `aria-checked`로 읽고, 글까지 이름에 섞여 «켬, 스위치, 켜짐»처럼 두 번 읽히지 않게 한다. 제어형(`checked`)이면 그 값을, 아니면 안에서 센 값을 글로 보인다.
 */
export function Toggle({ label, onText, offText, className, checked, defaultChecked, onCheckedChange, ...props }: ToggleProps) {
  const labelId = useId();
  const [inner, setInner] = useState(!!defaultChecked);
  const on = checked ?? inner;
  return (
    <label data-slot="ds-toggle-field" className={cn('inline-flex min-h-ds-control-sm cursor-pointer items-center gap-2 text-ds-body text-ds-ink touch:min-h-ds-touch has-data-disabled:cursor-not-allowed has-data-disabled:text-ds-ink-3', className)}>
      <SwitchPrimitive.Root
        data-slot="ds-toggle"
        aria-labelledby={labelId}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(next, details) => {
          onCheckedChange?.(next, details);
          // 호출부가 details.cancel()로 바꿈을 막았으면 Base UI는 그대로이므로 글도 따라 바꾸지 않는다(글과 실제 상태가 갈리지 않게).
          if (!details.isCanceled) setInner(next);
        }}
        className={`group/toggle relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-ds-line-control bg-ds-surface-sunk outline-none focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background data-checked:border-ds-action data-checked:bg-ds-action data-disabled:cursor-not-allowed ${DATA_DISABLED_FACE}`}
        {...props}
      >
        <SwitchPrimitive.Thumb className="pointer-events-none block size-3 translate-x-0.5 rounded-full bg-ds-ink-2 transition-transform duration-(--ds-duration-fast) motion-reduce:transition-none data-checked:translate-x-3.5 data-checked:bg-ds-on-action group-data-[disabled]/toggle:bg-ds-ink-3 group-data-[disabled]/toggle:data-checked:bg-ds-ink-3" />
      </SwitchPrimitive.Root>
      <span id={labelId}>{label}</span>
      <span data-slot="ds-toggle-state" aria-hidden="true" className="font-mono text-ds-mono-md text-ds-ink-3">
        {on ? onText : offText}
      </span>
    </label>
  );
}
