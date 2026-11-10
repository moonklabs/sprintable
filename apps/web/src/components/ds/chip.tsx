'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

/**
 * UI-3(a9d56577) Chip · Tag — doc §4 #5. 칩 = 상태(점 + 글) · 필터 · 커맨드 · AI 표시, 태그 = 고정폭 꼬리표(에이전트).
 * 색은 «뜻»일 때만(`needs-hand` 손 필요 · `done` 끝남 · `failed` 실패 · `info` AI 표시 / 중립 안내 · `action` 선택) — 그 밖에는 중립.
 * 경계는 항상 중립 `ds-line`(뜻 색은 글과 옅은 바탕에만) — 색만으로 뜻을 싣지 않게 점 · 아이콘 · 글이 함께 간다.
 */
export const chipVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ds-tag border border-ds-line px-1.5 font-mono text-ds-mono-md',
  {
    variants: {
      tone: {
        neutral: 'bg-ds-surface-high text-ds-ink-2',
        'needs-hand': 'bg-ds-needs-hand-soft text-ds-needs-hand',
        done: 'bg-ds-done-soft text-ds-done',
        failed: 'bg-ds-failed-soft text-ds-failed',
        info: 'bg-ds-info-soft text-ds-info',
        action: 'bg-ds-action-soft text-ds-action-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const DOT_BG: Record<NonNullable<VariantProps<typeof chipVariants>['tone']>, string> = {
  neutral: 'bg-ds-ink-3',
  'needs-hand': 'bg-ds-needs-hand-bar',
  done: 'bg-ds-done',
  failed: 'bg-ds-failed',
  info: 'bg-ds-info',
  action: 'bg-ds-action',
};

type ChipMarker = { dot?: false; icon?: IconName } | { dot: true; icon?: never };

export type ChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & VariantProps<typeof chipVariants> & ChipMarker & { children: ReactNode };

/** 글 앞 표시는 점(상태) **또는** 아이콘 하나 — 둘을 같이 주면(타입이 막는다) 점만 그린다. */
export function Chip({ tone = 'neutral', dot = false, icon, className, children, ...props }: ChipProps) {
  return (
    <span data-slot="ds-chip" data-tone={tone} className={cn(chipVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden="true" data-chip-dot className={cn('size-1.5 shrink-0 rounded-full', DOT_BG[tone ?? 'neutral'])} /> : null}
      {icon && !dot ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/** 고정폭 꼬리표(mono-sm 10px) — 중립. 색을 입히지 않는다(에이전트 구분은 모양 + 이 꼬리표). */
export function Tag({ className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return (
    <span
      data-slot="ds-tag"
      className={cn('inline-flex shrink-0 items-center rounded-ds-tag border border-ds-line bg-ds-surface-high px-1 font-mono text-ds-mono-sm tracking-wider text-ds-ink-3', className)}
      {...props}
    >
      {children}
    </span>
  );
}

/** 「에이전트」 꼬리표 — 현행 `chats.agent` 키를 그대로 쓴다(ko «에이전트» · en «Agent»). */
export function AgentTag({ className }: { className?: string }) {
  const t = useTranslations('chats');
  return <Tag data-slot="ds-agent-tag" className={className}>{t('agent')}</Tag>;
}
