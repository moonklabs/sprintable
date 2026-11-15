import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** UI-3(a9d56577) Kbd — 단축키 표기(고정폭 · 작은 칸). 장식이 아니라 «키 이름»이므로 글 그대로 읽힌다. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      data-slot="ds-kbd"
      className={cn('inline-flex min-w-5 items-center justify-center rounded-ds-tag border border-ds-line bg-ds-surface-high px-1 font-mono text-ds-mono-md text-ds-ink-2', className)}
      {...props}
    />
  );
}
