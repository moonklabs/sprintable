'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from './button';
import { Icon } from './icon';
import { stateBlockClass } from './state-block';

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'title' | 'children' | 'className'> {
  /** 한 줄 — 무엇을 못 했나. 안 주면 «문제가 발생했어요». */
  title?: ReactNode;
  description?: ReactNode;
  /** 주면 «다시 시도» 단추(ds Button · 높이 40 · 폰 44)가 생긴다. */
  onRetry?: () => void;
  /** «다시 시도» 말을 바꿔야 할 때만(예: «다시 불러오기»). */
  retryLabel?: ReactNode;
  /** 재시도 옆에 붙는 다른 행동(Button). */
  children?: ReactNode;
  /** `inline` — 목록 «사이»에 끼는 짧은 칸(위아래 16). 기본은 영역을 채우는 에러. */
  size?: 'default' | 'inline';
  className?: string;
}

/**
 * story 5048 ⑤ ErrorState — 영역 «전체»를 못 그릴 때의 에러 한 모양(홈 · 설정 · 에이전트가 제각각이던 것). 화면의 «일부» 알림이나 닫을 수 있는 띠는 `Banner tone="failed"`가 계속 맡는다.
 * 뼈대는 `EmptyState`와 같다(`state-block.ts`). 색은 아이콘에만 — 제목은 잉크(붉은 글자 없음 · 대비). `role=alert`라 나타나면 바로 읽힌다.
 * 인라인(목록 사이)도 아이콘을 둔다 — 에러는 색 없이도 «에러»로 알아봐야 해서(빈 상태 inline은 아이콘 없음).
 */
export function ErrorState({ title, description, onRetry, retryLabel, children, size = 'default', className, ...rest }: ErrorStateProps) {
  const t = useTranslations('common');
  const inline = size === 'inline';
  return (
    <div {...rest} role="alert" aria-live="assertive" aria-atomic="true" data-slot="ds-error-state" data-size={size} className={stateBlockClass(inline, className)}>
      <Icon name="error" size={inline ? 'sm' : 'lg'} className="text-ds-failed" />
      <p className="m-0 break-keep text-ds-card-title font-semibold text-ds-ink [overflow-wrap:anywhere]">{title ?? t('error')}</p>
      {description ? <p className="m-0 max-w-sm break-keep text-ds-small text-ds-ink-2 [overflow-wrap:anywhere]">{description}</p> : null}
      {onRetry || children ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? <Button variant="secondary" size="md" onClick={() => onRetry()}>{retryLabel ?? t('retry')}</Button> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
