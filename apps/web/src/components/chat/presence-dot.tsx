'use client';

import { useTranslations } from 'next-intl';

/**
 * 1aeecdde P2 — 에이전트 presence 2축 시각(설계 `handoff-presence-working-typing`).
 * - 연결 축(P1 `presence_status` 진실): offline/idle/online → avatar 우하단 dot.
 * - 활동 축(P2): working(답장 생성 중) → avatar에 working pulse ring(아래 WORKING_RING_CLASS).
 *   **dot 색을 바꾸지 않고 ring을 덧댄다**(AC2 — 축 합침 금지·'online인데 idle vs 일하는 중' 구분).
 * 휴먼은 presence_status null → dot 미표시.
 */
export type PresenceStatus = 'online' | 'idle' | 'offline';

const DOT_CLASS: Record<PresenceStatus, string> = {
  online: 'bg-success',
  idle: 'bg-warning',
  offline: 'bg-muted-foreground/40',
};

const STATUS_LABEL_KEY: Record<PresenceStatus, string> = {
  online: 'presenceOnline',
  idle: 'presenceIdle',
  offline: 'presenceOffline',
};

/**
 * 활동 축 — working 시 avatar 래퍼에 덧대는 ring(brand pulse). dot과 별개(축 합침 금지).
 * prefers-reduced-motion 시 정적 ring(모션 0).
 */
export const WORKING_RING_CLASS = 'ring-2 ring-brand ring-offset-1 ring-offset-card motion-safe:animate-pulse';

/** 연결 축 dot(avatar 우하단). status null/undefined(휴먼·미상)면 미표시. */
export function PresenceDot({
  status,
  className = '',
}: {
  status: PresenceStatus | null | undefined;
  className?: string;
}) {
  const t = useTranslations('chats');
  if (!status) return null;
  return (
    <span
      role="img"
      aria-label={t(STATUS_LABEL_KEY[status])}
      className={`inline-block size-2.5 rounded-full border-2 border-card ${DOT_CLASS[status]} ${className}`}
    />
  );
}
