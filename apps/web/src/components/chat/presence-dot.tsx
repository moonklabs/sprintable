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
 * 활동 축 — working 시 avatar 래퍼에 덧대는 ring. dot과 별개(축 합침 금지).
 * prefers-reduced-motion 시 정적 ring(모션 0).
 *
 * story #2921(유나 합성 5규칙③, avatar-unification-design-memo-2921, 2026-08-22 확定) —
 * 개명+색 스왑. 옛 이름(WORKING_RING_CLASS)·값(ring-info, --info가 proof-blue로 별칭돼
 * 사실상 이미 blue였다)이 규칙③(idle=blue 정적·working=citron 펄스)과 정반대였다 — idle
 * 에이전트 링(avatar.tsx)이 blue로 바뀌며 「working만 다른 색」이라는 이 상수의 존재 이유가
 * citron으로 넘어갔다. 소비처는 avatar.tsx 1곳뿐(챗 아바타 옛 hand-rolled 마크업은 #3335가
 * Avatar로 흡수하며 이미 소거됨).
 */
export const AGENT_LIVE_RING_CLASS = 'ring-2 ring-proof-citron ring-offset-1 ring-offset-card motion-safe:animate-pulse';

// 2505d27d: 패널은 큰 영역이라 prominent하게(size-3·12px) — 채팅 dot(size-2.5·10px)보다 가시성↑(모바일 교훈).
const SIZE_CLASS = { sm: 'size-2.5', md: 'size-3' } as const;

/** 연결 축 dot(avatar 우하단). status null/undefined(휴먼·미상)면 미표시. size: sm(채팅)·md(패널). */
export function PresenceDot({
  status,
  size = 'sm',
  className = '',
}: {
  status: PresenceStatus | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const t = useTranslations('chats');
  if (!status) return null;
  return (
    <span
      role="img"
      aria-label={t(STATUS_LABEL_KEY[status])}
      className={`inline-block ${SIZE_CLASS[size]} rounded-full border-2 border-card ${DOT_CLASS[status]} ${className}`}
    />
  );
}
