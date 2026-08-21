'use client';

import { Bot, User } from 'lucide-react';
import { PresenceDot, WORKING_RING_CLASS, type PresenceStatus } from '@/components/chat/presence-dot';
import { avatarColor, initials } from '@/lib/storage/format';
import { cn } from '@/lib/utils';

export interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  actorType: 'human' | 'agent';
  /** px 정사각. 기본 32(채팅 L1~L3 표준 규격은 호출부가 size로 스케일). */
  size?: number;
  /** agent 전용 — 연결 축 dot. 휴먼은 항상 미표시. */
  presenceStatus?: PresenceStatus | null;
  /** agent 전용 — 활동 축(WORKING_RING_CLASS, pulsing). 미작동 시 정적 accent-claim 링(항상
   * "에이전트임" 식별 — 이미지가 있어도 유지, S2g 목업 규칙). */
  isWorking?: boolean;
  className?: string;
}

/**
 * story #2887(S2g) — 행위자 아바타 단일 프리미티브. `avatar_url` 3단 폴백(이미지→이니셜→
 * Bot/User 아이콘) + 에이전트 식별(정적 링 + presence dot + BOT 배지, 이미지 있어도 유지 —
 * 휴먼과 안 헷갈리게). 목업 `s2g-avatar-mockup` 1:1. storage-uploader-avatar.tsx의 initials/
 * avatarColor 헬퍼를 그대로 재사용(이니셜 폴백 로직 중복 방지).
 */
export function Avatar({
  name, avatarUrl, actorType, size = 32, presenceStatus, isWorking = false, className,
}: AvatarProps) {
  const isAgent = actorType === 'agent';
  const dotSize = size >= 40 ? 'md' : 'sm';
  const iconSize = Math.round(size * 0.5);
  const initSize = Math.round(size * 0.4);
  const badgeSize = Math.max(14, Math.round(size * 0.32));

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className={cn(
          'h-full w-full overflow-hidden rounded-full',
          isAgent && (isWorking ? WORKING_RING_CLASS : 'ring-2 ring-accent-claim ring-offset-1 ring-offset-background'),
        )}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
        ) : name.trim() ? (
          <span
            className={cn('flex h-full w-full items-center justify-center font-semibold text-white', avatarColor(name))}
            style={{ fontSize: initSize }}
            aria-label={name}
          >
            {initials(name)}
          </span>
        ) : (
          <span
            className={cn(
              'flex h-full w-full items-center justify-center',
              isAgent ? 'bg-accent-claim/15 text-accent-claim' : 'bg-muted text-muted-foreground',
            )}
            aria-label={name}
          >
            {isAgent ? <Bot style={{ width: iconSize, height: iconSize }} /> : <User style={{ width: iconSize, height: iconSize }} />}
          </span>
        )}
      </div>

      {isAgent && (
        <span
          className="absolute -right-1.5 -top-1.5 rounded border border-accent-claim/40 bg-accent-claim/15 font-bold text-accent-claim"
          style={{ fontSize: Math.max(7, Math.round(badgeSize * 0.55)), lineHeight: 1, padding: '2px 3px' }}
        >
          AI
        </span>
      )}
      {isAgent && presenceStatus ? (
        <PresenceDot status={presenceStatus} size={dotSize} className="absolute -bottom-0.5 -right-0.5" />
      ) : null}
    </div>
  );
}
