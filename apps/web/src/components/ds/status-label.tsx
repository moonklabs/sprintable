import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

const STATUS = {
  /** 연결됨 · 끝남 · 통과 */
  online: { mark: 'dot', color: 'bg-ds-done', text: 'text-ds-ink-2' },
  /** 자리 비움 · 쉬는 중(연결 중간 단계) */
  idle: { mark: 'dot', color: 'bg-ds-ink-3', text: 'text-ds-ink-2' },
  /** 연결 끊김 — 속 빈 점(색만으로 말하지 않는다) */
  offline: { mark: 'ring', color: 'border-ds-ink-3', text: 'text-ds-ink-3' },
  /** 일하는 중(활동 축) — action 점이 천천히 깜빡인다(움직임 줄이기면 멈춤) */
  working: { mark: 'pulse', color: 'bg-ds-action', text: 'text-ds-ink-2' },
  /** 내 손이 필요 — 점이 아니라 touch_app 아이콘이 붙는다 */
  'needs-hand': { mark: 'icon', icon: 'touch_app', color: 'text-ds-needs-hand', text: 'text-ds-needs-hand' },
  /** 실패 · 거부 · 오류 — error 아이콘 */
  failed: { mark: 'icon', icon: 'error', color: 'text-ds-failed', text: 'text-ds-failed' },
} as const satisfies Record<string, { mark: 'dot' | 'ring' | 'pulse' | 'icon'; icon?: IconName; color: string; text: string }>;

export type StatusKind = keyof typeof STATUS;

export interface StatusLabelProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: StatusKind;
  /** 상태를 말하는 글 — 필수(점 · 아이콘만으로는 뜻이 안 읽힌다). 예: «연결됨» · «손 필요 2». */
  label: string;
}

/**
 * UI-3(a9d56577) StatusLabel — doc §4 #15. 표시(점 · 속 빈 점 · 깜빡이는 점 · 아이콘) + 고정폭 글 한 줄.
 * 표시는 장식(`aria-hidden`)이고 뜻은 항상 글이 싣는다. 손 필요 · 실패는 점이 아니라 아이콘이 붙는다.
 */
export function StatusLabel({ status, label, className, ...props }: StatusLabelProps) {
  const spec = STATUS[status];
  return (
    <span data-slot="ds-status-label" data-status={status} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-ds-mono-md', spec.text, className)} {...props}>
      {spec.mark === 'icon' ? (
        <Icon name={spec.icon} size={14} className={cn('shrink-0', spec.color)} />
      ) : (
        <span
          aria-hidden="true"
          data-mark={spec.mark}
          className={cn('size-2 shrink-0 rounded-full', spec.mark === 'ring' ? cn('border bg-transparent', spec.color) : spec.color, spec.mark === 'pulse' && 'motion-safe:animate-pulse')}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
