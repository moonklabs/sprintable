'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Icon } from './icon';

export interface SectionHeaderProps {
  title: ReactNode;
  /** 건수 배지 · 보조 글 자리(호출부가 CountBadge 등을 준다). */
  count?: ReactNode;
  /** 오른쪽 보조 글 · 단추. */
  trailing?: ReactNode;
  /** «내 손이 필요» 구역 — touch_app 아이콘 + 제목 색 needs-hand. */
  tone?: 'default' | 'needs-hand';
  /** 접기를 쓰면 둘 다 준다. collapsed가 undefined면 접히지 않는 머리글. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** 접근성: 머리글 단계(기본 3). */
  level?: 2 | 3 | 4;
  className?: string;
}

/**
 * UI-3(a9d56577) SectionHeader — doc v0.3 #18. 높이 32 · 왼쪽 접기 화살표 + 제목 + 건수 + 오른쪽 보조.
 * 접히는 머리글은 단추(`aria-expanded`)이고 접히지 않는 머리글은 글만이다.
 */
export function SectionHeader({ title, count, trailing, tone = 'default', collapsed, onToggle, level = 3, className }: SectionHeaderProps) {
  const collapsible = collapsed !== undefined && !!onToggle;
  const needsHand = tone === 'needs-hand';
  const inner = (
    <>
      {collapsible ? <Icon name={collapsed ? 'chevron_right' : 'expand_more'} /> : null}
      {needsHand ? <Icon name="touch_app" className="text-ds-needs-hand" /> : null}
      <span className={cn('text-ds-card-title font-semibold', needsHand ? 'text-ds-needs-hand' : 'text-ds-ink')}>{title}</span>
      {count}
    </>
  );
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <div data-slot="ds-section-header" data-tone={tone} className={cn('flex h-8 items-center gap-2 border-b border-ds-line bg-ds-surface-sunk px-3', className)}>
      <Heading className="m-0 flex min-w-0 flex-1 items-center">
        {collapsible ? (
          <Button
            type="button"
            variant="quiet"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="h-auto min-w-0 justify-start gap-2 border-transparent px-0 hover:bg-transparent"
          >
            {inner}
          </Button>
        ) : (
          <span className="flex min-w-0 items-center gap-2">{inner}</span>
        )}
      </Heading>
      {trailing ? <div className="flex shrink-0 items-center gap-2 font-mono text-ds-mono-md text-ds-ink-3">{trailing}</div> : null}
    </div>
  );
}
