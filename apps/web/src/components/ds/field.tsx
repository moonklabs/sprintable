'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export interface FieldControlProps {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
}

export interface FieldProps {
  /** 보이는 이름 — 필수(자리표시 글로 이름을 대신하지 않는다). */
  label: ReactNode;
  /** 칸 아래 도움말(오류가 있으면 오류가 대신 보인다). */
  hint?: ReactNode;
  /** 오류 글 — 있으면 칸이 `aria-invalid`가 되고 `error` 아이콘 + 글이 칸 아래에 보인다(색만으로 말하지 않는다). */
  error?: ReactNode;
  /** 칸을 그리는 함수 — 받은 `id` · `aria-*`를 칸(Input · Textarea …)에 그대로 펼친다. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/**
 * UI-3(a9d56577) Field — 이름 + 칸 + 도움말 / 오류 한 묶음. 이름은 `label for`, 오류 · 도움말은 `aria-describedby`로 칸에 이어진다.
 * 오류 글은 `role=alert`(나타날 때 바로 읽힘).
 */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = !!error || !!hint;
  return (
    <div data-slot="ds-field" className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-ds-small font-semibold text-ds-ink">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': hasNote ? noteId : undefined })}
      {error ? (
        <p id={noteId} role="alert" className="flex items-start gap-1 text-ds-small text-ds-failed break-keep [overflow-wrap:anywhere]">
          <Icon name="error" size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={noteId} className="text-ds-small text-ds-ink-3 break-keep [overflow-wrap:anywhere]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
