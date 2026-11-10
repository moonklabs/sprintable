import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * UI-3(a9d56577) Card — doc §4 #9. 한 단계 올린 면(`surface`) + 헤어라인 + 모서리 4 · 그림자 0.
 * `needs-hand` = 왼쪽 4px 막대(손 필요) · `selected` = action 2px 윤곽. `CardInset`은 카드 안 데이터 칸(한 단계 내린 면).
 */
export const cardVariants = cva('rounded-ds-control border border-ds-line bg-ds-surface text-ds-ink', {
  // 순서가 뜻이다: selected(border-ds-action)가 먼저, tone의 왼쪽 막대(border-l-…)가 나중 — tailwind-merge가 뒤의 한쪽 선 색을 살려 «선택 + 손 필요»에도 막대가 남는다.
  variants: {
    selected: { true: 'border-ds-action ring-1 ring-ds-action', false: '' },
    tone: {
      default: '',
      'needs-hand': 'border-l-4 border-l-ds-needs-hand-bar',
    },
  },
  defaultVariants: { tone: 'default', selected: false },
});

type CardTone = { tone?: 'default' } | { tone: 'needs-hand'; /** 화면에 안 보이는 이름(예: «내 손이 필요»). 막대 색만으로 뜻을 싣지 않는다. */ toneLabel: string };

export type CardProps = HTMLAttributes<HTMLDivElement> & Pick<VariantProps<typeof cardVariants>, 'selected'> & CardTone;

export function Card({ tone, selected, className, children, ...rest }: CardProps) {
  const { toneLabel, ...props } = rest as typeof rest & { toneLabel?: string };
  return (
    <div data-slot="ds-card" data-tone={tone ?? 'default'} aria-current={selected || undefined} className={cn(cardVariants({ tone, selected }), className)} {...props}>
      {tone === 'needs-hand' && toneLabel ? <span className="sr-only">{toneLabel}</span> : null}
      {children}
    </div>
  );
}

export function CardInset({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="ds-card-inset" className={cn('rounded-ds-control border border-ds-line bg-ds-surface-sunk px-2 py-1.5 font-mono text-ds-mono-md text-ds-ink-2', className)} {...props} />;
}
