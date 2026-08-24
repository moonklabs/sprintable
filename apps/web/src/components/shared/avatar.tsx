'use client';

import { useState } from 'react';
import { Bot, User } from 'lucide-react';
import { PresenceDot, AGENT_LIVE_RING_CLASS, type PresenceStatus } from '@/components/chat/presence-dot';
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
  /** agent 전용 — 활동 축(AGENT_LIVE_RING_CLASS, citron pulse). 미작동 시 정적 proof-blue 링
   * (항상 "에이전트임" 식별 — 이미지가 있어도 유지, S2g 목업 규칙+#2921 규칙③ 색 스왑). */
  isWorking?: boolean;
  className?: string;
}

/**
 * story #2887(S2g) — 행위자 아바타 단일 프리미티브. `avatar_url` 3단 폴백(이미지→이니셜→
 * Bot/User 아이콘) + 에이전트 식별(정적 링 + presence dot + BOT 배지, 이미지 있어도 유지 —
 * 휴먼과 안 헷갈리게). 목업 `s2g-avatar-mockup` 1:1. storage-uploader-avatar.tsx의 initials/
 * avatarColor 헬퍼를 그대로 재사용(이니셜 폴백 로직 중복 방지).
 *
 * story #2921(유나 합성 5규칙, avatar-unification-design-memo-2921, 2026-08-22 확定) — 3339
 * (챗 Proofline)의 ProofAvatar를 여기로 흡수·폐기(사본 분화 금지, 규칙⑤ 단일 컴포넌트).
 * 스코프=전 표면 단일 문법(규칙 확定 ⓐ) — 챗 전용 override 없음, 아래 소비처 전부(챗·조직
 * 인력·아바타 편집·팀 프레즌스 패널) 동일 시각을 받는다:
 * ②형태 — shape는 actorType에서 자동 유도(agent=circle·human=square, 이미지도 그 형태로
 * clip — overflow-hidden 래퍼의 반경만 바꾸면 이미지 tier도 자동으로 따라온다). human은
 * 색과 별개의 테두리(border-proof-line)로 redundant 경계 신호를 더한다.
 * ③idle 에이전트=Proof Blue 정적 링(ring-proof-blue)·working=citron 펄스(AGENT_LIVE_RING_CLASS,
 * presence-dot.tsx — 옛 WORKING_RING_CLASS 개명+색 스왑, 그 파일 주석 참고).
 */
export function Avatar({
  name, avatarUrl, actorType, size = 32, presenceStatus, isWorking = false, className,
}: AvatarProps) {
  const isAgent = actorType === 'agent';
  const dotSize = size >= 40 ? 'md' : 'sm';
  const iconSize = Math.round(size * 0.5);
  const initSize = Math.round(size * 0.4);
  const badgeSize = Math.max(14, Math.round(size * 0.32));

  // 카디르군 QA(#3304, HIGH) — avatar_url 「문자열 유무」만 보고 이미지 tier로 갔다: GCS
  // object 삭제·서명 만료·환경간 버킷 불일치로 실제 로드가 실패해도 native onError를 안 받아
  // 깨진 이미지가 영구 잔류했다(3단 폴백 계약의 본체 결함). onError로 감지해 다음 tier(이니셜/
  // 아이콘)로 실제 폴백한다 — avatar_url이 바뀌면(교체 업로드 등) 새 URL을 다시 시도해야 하므로
  // "prop 변경에 맞춰 state 조정"을 렌더 중(effect 아님, react-hooks/set-state-in-effect 회피)에
  // 한다 — React 공식 패턴(https://react.dev/learn/you-might-not-need-an-effect).
  const [imgError, setImgError] = useState(false);
  const [lastAvatarUrl, setLastAvatarUrl] = useState(avatarUrl);
  if (avatarUrl !== lastAvatarUrl) {
    setLastAvatarUrl(avatarUrl);
    setImgError(false);
  }
  const showImage = !!avatarUrl && !imgError;

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className={cn(
          'h-full w-full overflow-hidden',
          isAgent ? 'rounded-full' : 'rounded-md border border-proof-line',
          isAgent && (isWorking ? AGENT_LIVE_RING_CLASS : 'ring-2 ring-proof-blue ring-offset-1 ring-offset-background'),
        )}
      >
        {showImage ? (
          // avatar_url은 avatar 전용 GCS public-read 버킷의 임의 서빙 도메인(dev/prod
          // 버킷명이 갈리고 next.config의 remotePatterns 사전 등록이 안 됨) — 기존 관례
          // (storage-uploader-avatar.tsx·team-presence-panel.tsx·profile-menu.tsx 전부 동일
          // 이유로 raw img)와 동형. next/image 전환은 별도 remotePatterns 검토 스토리 몫.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={name} className="h-full w-full object-cover" onError={() => setImgError(true)} />
        ) : name.trim() ? (
          <span
            className={cn('flex h-full w-full items-center justify-center font-semibold', avatarColor(isAgent))}
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
          className="absolute -right-1.5 -top-1.5 rounded border border-accent-claim/40 bg-accent-claim/15 font-bold text-foreground"
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
