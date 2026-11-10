import type { HTMLAttributes } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * UI-3(a9d56577) CountBadge — doc §4 #6. 한 모양 · 색은 뜻 둘: **읽지 않음(새 글) = `action`** / **결재 대기(내 손 필요) = `needs-hand-bar`**.
 * 한 방에 둘 다 있으면 호출부가 배지를 둘 그린다(호박 먼저). 99를 넘으면 «99+».
 */
export const countBadgeVariants = cva(
  'inline-grid h-4 min-w-4.5 shrink-0 place-items-center rounded-ds-tag px-1 font-mono text-ds-mono-sm font-semibold',
  {
    variants: {
      kind: {
        unread: 'bg-ds-action text-ds-on-action',
        'needs-hand': 'bg-ds-needs-hand-bar text-ds-on-needs-hand',
      },
    },
    defaultVariants: { kind: 'unread' },
  },
);

type CountBadgeKind =
  | { kind?: 'unread'; label?: string }
  /** 내 손이 필요한 수는 색 + 글로 말한다 — 화면에 안 보이는 이름(예: «결재 대기»)이 필수다(스크린리더 · 색맹). */
  | { kind: 'needs-hand'; label: string };

export type CountBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  count: number;
  /** 이 수를 넘으면 «{max}+»로 줄인다. 기본 99. */
  max?: number;
  /** the number is a minimum (part of what feeds it could not be read): drawn «N+» and not as an exact count */
  atLeast?: boolean;
} & CountBadgeKind;

export function CountBadge({ count, max = 99, atLeast = false, kind = 'unread', label, className, ...props }: CountBadgeProps) {
  return (
    <span data-slot="ds-count-badge" data-kind={kind} className={cn(countBadgeVariants({ kind }), className)} {...props}>
      {label ? <span className="sr-only">{label} </span> : null}
      {count > max ? `${max}+` : atLeast ? `${count}+` : count}
    </span>
  );
}
