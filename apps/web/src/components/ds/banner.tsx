'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';
import { IconButton } from './icon-button';

const TONES = {
  /** 안내 · AI 표시 — 부분 로드 «불러온 N건 안에서만» 같은 중립 안내. */
  info: { icon: 'info', box: 'border-ds-info/40 bg-ds-info-soft', iconColor: 'text-ds-info', role: 'status' },
  /** 사람이 지금 할 일 — 왼쪽 막대 + touch_app(색만으로 뜻을 싣지 않는다). 막대는 `soft` 바탕 위라 `needs-hand-bar`(2.82:1)가 아니라 글 색 `needs-hand`(5.5:1)를 쓴다. */
  'needs-hand': { icon: 'touch_app', box: 'border-ds-needs-hand-bar/40 bg-ds-needs-hand-soft border-l-4 border-l-ds-needs-hand', iconColor: 'text-ds-needs-hand', role: 'status' },
  /** 이미 실패했거나 막힘. */
  failed: { icon: 'error', box: 'border-ds-failed/40 bg-ds-failed-soft', iconColor: 'text-ds-failed', role: 'alert' },
  /** 그 밖의 주의 문구 — 색 없이 중립 면 + warning 아이콘(새 호박 색을 만들지 않는다). */
  note: { icon: 'warning', box: 'border-ds-line bg-ds-surface-high', iconColor: 'text-ds-ink-2', role: 'status' },
} as const satisfies Record<string, { icon: IconName; box: string; iconColor: string; role: 'status' | 'alert' }>;

export type BannerTone = keyof typeof TONES;

export interface BannerProps {
  tone?: BannerTone;
  /** 글(한 줄이 기본, 길면 줄바꿈). */
  children: ReactNode;
  /** 오른쪽 행동(Button 등) — 행동이 붙은 띠는 여기로. */
  action?: ReactNode;
  /** 주면 닫기 단추가 생긴다. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * UI-3(a9d56577) Banner — doc v0.3 #30. 전폭 · 최소 높이 36 · 왼쪽 아이콘 + 글 + (행동) + (닫기).
 * `failed`는 `role=alert`(즉시 읽힘), 나머지는 `role=status`(흐름을 끊지 않음).
 */
export function Banner({ tone = 'info', children, action, onDismiss, className }: BannerProps) {
  const t = useTranslations('common');
  const spec = TONES[tone];
  return (
    <div
      role={spec.role}
      data-slot="ds-banner"
      data-tone={tone}
      className={cn('flex min-h-ds-control w-full items-center gap-2 border px-3 py-1.5 text-ds-body text-ds-ink', spec.box, className)}
    >
      <Icon name={spec.icon} className={cn('shrink-0', spec.iconColor)} />
      <div className="min-w-0 flex-1 break-keep [overflow-wrap:anywhere]">{children}</div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      {onDismiss ? <IconButton icon="close" label={t('close')} onClick={onDismiss} /> : null}
    </div>
  );
}
