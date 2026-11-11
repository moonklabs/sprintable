'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Icon, type IconName } from './icon';
import { IconButton } from './icon-button';

const KINDS = {
  info: { icon: 'info', box: 'bg-ds-info-soft border-ds-info/40', iconColor: 'text-ds-info', role: 'status' },
  /** 되돌리기가 붙은 알림 — 보조 단추 «되돌리기». */
  undo: { icon: 'undo', box: 'bg-ds-surface-raised border-ds-line', iconColor: 'text-ds-ink-2', role: 'status' },
  error: { icon: 'error', box: 'bg-ds-failed-soft border-ds-failed/40', iconColor: 'text-ds-failed', role: 'alert' },
} as const satisfies Record<string, { icon: IconName; box: string; iconColor: string; role: 'status' | 'alert' }>;

export type ToastKind = keyof typeof KINDS;

export interface ToastCardProps {
  kind?: ToastKind;
  title: ReactNode;
  body?: ReactNode;
  /** 보조 단추(예: «되돌리기»). 누르면 `onAction`. */
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** 둘째 줄을 한 줄 말줄임으로(파일 이름 등). 기본은 어디서나 끊어 감는다. */
  bodySingleLine?: boolean;
  /** 붙잡기(포인터 · 초점이 카드 안에 있으면 안 닫힘)를 제공자가 카드 뿌리에 거는 자리 — 수명 코드는 제공자(`useToastLifecycle`)에 있다. */
  holdProps?: Pick<HTMLAttributes<HTMLDivElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'>;
  className?: string;
}

/**
 * UI-3(a9d56577) Toast 카드 — doc v0.3 #19의 «모양». 폭 360(좁은 화면은 양쪽 16px을 남기고 가득 — 바깥 상자가 폭이 없어도(dock 열 `items-end`) 카드 자신이 폭을 쥔다) · 세 종: 오류(`role=alert`) · 되돌리기 · 정보.
 * 모양만 이 부품이 맡는다 — 쌓기 · 8초 타이머 · 호버/초점 중 유지 · 닫힌 까닭(onClose)은 지금의 `ToastProvider`가 그대로 맡고,
 * 영역 주인이 새 화면을 지을 때 그 Provider의 카드 자리에 이 카드를 끼운다(타이머를 두 곳에 두지 않는다).
 */
export function ToastCard({ kind = 'info', title, body, actionLabel, onAction, onDismiss, bodySingleLine = false, holdProps, className }: ToastCardProps) {
  const t = useTranslations('common');
  const spec = KINDS[kind];
  return (
    <div
      {...holdProps}
      role={spec.role}
      aria-live={spec.role === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-slot="ds-toast"
      data-kind={kind}
      className={cn('flex w-[min(22.5rem,calc(100vw-2rem))] max-w-full animate-ds-slide-in items-start gap-2 rounded-ds-panel border p-3 text-ds-ink shadow-ds-popup motion-reduce:animate-none', spec.box, className)}
    >
      <Icon name={spec.icon} className={cn('mt-0.5 shrink-0', spec.iconColor)} />
      <div className="min-w-0 flex-1">
        <p className="text-ds-body font-semibold break-keep [overflow-wrap:anywhere]">{title}</p>
        {body ? <p className={cn('mt-0.5 text-ds-small text-ds-ink-2', bodySingleLine ? 'truncate' : 'break-keep [overflow-wrap:anywhere]')}>{body}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <Button variant="secondary" onClick={onAction} className="shrink-0">
          {actionLabel}
        </Button>
      ) : null}
      <IconButton icon="close" label={t('close')} onClick={onDismiss} className="shrink-0" />
    </div>
  );
}
