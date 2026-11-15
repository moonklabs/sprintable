import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

export interface EmptyStateProps {
  icon?: IconName;
  /** 한 줄 — 왜 비었나(«0건»만 쓰지 않는다). */
  title: ReactNode;
  description?: ReactNode;
  /** 다음 행동 하나(Button). */
  action?: ReactNode;
  /** `inline` — 목록 «사이»에 끼는 짧은 빈 칸(위아래 16 · 아이콘 없음). 기본은 화면 한가운데 큰 빈 상태. */
  size?: 'default' | 'inline';
  className?: string;
}

/** UI-3(a9d56577) EmptyState — doc §4 #16. 한 줄 + 다음 행동 하나. 일러스트 없음. */
export function EmptyState({ icon, title, description, action, size = 'default', className }: EmptyStateProps) {
  const inline = size === 'inline';
  return (
    <div data-slot="ds-empty-state" data-size={size} className={cn('flex flex-col items-center gap-2 px-6 text-center', inline ? 'py-4' : 'py-10', className)}>
      {icon && !inline ? <Icon name={icon} size={24} className="text-ds-ink-3" /> : null}
      <p className="m-0 text-ds-card-title font-semibold text-ds-ink">{title}</p>
      {description ? <p className="m-0 max-w-sm text-ds-small text-ds-ink-2">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
