'use client';

import { useState } from 'react';
import { Bot, User } from 'lucide-react';
import { PresenceDot, AGENT_LIVE_RING_CLASS, type PresenceStatus } from '@/components/chat/presence-dot';
import { AGENT_MARK_FILL_CLASS } from '@/components/ui/agent-identity';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { CONNECTOR_BADGE_REGISTRY, getRuntimeDef, runtimeLabel } from '@/lib/runtime-capabilities';
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
  /** story #3092(2단계, 유나 픽셀 규격) — agent 전용, 커넥터 정체(runtime_type 원값).
   * hover 툴팁 2번째 줄("Agent · {runtimeLabel}")에만 쓰인다 — null/미배선 소비처는
   * "Agent" 단독으로 자동 폴백(전역 폴백 규칙, raw key 노출 없음 — runtimeLabel()이 흡수). */
  runtimeType?: string | null;
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
  name, avatarUrl, actorType, size = 32, presenceStatus, isWorking = false, runtimeType = null, className,
}: AvatarProps) {
  const isAgent = actorType === 'agent';
  const dotSize = size >= 40 ? 'md' : 'sm';
  const iconSize = Math.round(size * 0.5);
  const initSize = Math.round(size * 0.4);
  // "Agent" 텍스트 배지(옛 지오메트리, 무변경) 전용 사이즈 — 아래 커넥터 아이콘/이니셜
  // 배지(신규 원형 디스크)는 별도 diskSize를 쓴다(규격 §2, story #3092 3단계).
  const textBadgeSize = Math.max(14, Math.round(size * 0.32));

  // story #3092(3단계, 유나 규격 v3 doc cd8983c4) — 커넥터별 공식 아이콘 배지.
  // 폴백 사다리(§3): ①공식 아이콘(마크≥~11px→아바타≥28 + 에셋有 + 상표승인) →
  // ②이니셜(상표 미승인/에셋無 — 크기 tier 아님, 항상 적용) → ③"Agent" 텍스트
  // (아바타<28 조밀 리스트 또는 runtime_type=null).
  const runtimeDef = getRuntimeDef(runtimeType);
  const badgeDef = runtimeDef ? CONNECTOR_BADGE_REGISTRY[runtimeDef.key] : null;
  // story #3092(5단계 delta, 유나 실측 2026-08-26) — 상세 초상형 아이콘(hermes)은 전역
  // 임계(28)에서 blob으로 뭉개짐(av36 이하 실측 확認) — 커넥터별 minIconSize override +
  // 그 사이 구간(28~minIconSize) 전용 이니셜 폴백을 레지스트리 엔트리 필드로 얹는다(전역
  // 상수 아님 — 기하 마크 8종은 필드 미설정이라 기존 동작 그대로, 단순 마크로 교체되면
  // 필드만 지우면 원복).
  const minIconSize = badgeDef?.kind === 'icon' ? (badgeDef.minIconSize ?? 28) : 28;
  const showIconBadge = badgeDef?.kind === 'icon' && size >= minIconSize;
  const showInitialsBadge =
    badgeDef?.kind === 'initials' ||
    (badgeDef?.kind === 'icon' && !showIconBadge && !!badgeDef.initials && size >= 28);
  const showTextBadge = !showIconBadge && !showInitialsBadge;
  // 디스크 지름 = clamp(16, 아바타×0.40, 30) · 마크 = 디스크×0.68(규격 §1~2).
  const diskSize = Math.min(30, Math.max(16, Math.round(size * 0.4)));
  const markSize = Math.round(diskSize * 0.68);

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

  const avatarNode = (
    // story #3092(2단계, 표면2) — isAgent일 때 이 노드가 TooltipTrigger로 쓰인다. tabIndex=0
    // 없으면 키보드로 절대 포커스가 안 가 hover 전용(마우스만)이 되어버린다 — 접근성 필수.
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      tabIndex={isAgent ? 0 : undefined}
    >
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

      {isAgent && showIconBadge && badgeDef?.asset && (
        <span
          className={cn(
            'absolute -right-1 -top-1 flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-2 ring-background',
            // 규격 §4 — 모노(단색) 아이콘은 디스크를 테마 무관 고정 밝은색으로 박아 다크
            // 테마에서도 검정 마크 대비를 확保(무변형 원칙상 아이콘 자체 색은 절대 안
            // 건드린다), 마크는 디스크 안쪽 68%에 인셋. story #3119(유나 design 판정,
            // 실렌더 대조 290c33cb) — 풀컬러(color) 아이콘 중 배경이 solid 브랜드색인
            // 것(claude-code·openclaw jpg)은 68% 인셋+디스크 배경 조합이 사각 이미지와
            // 원형 마스크 사이에 코너 갭을 남겨 다크 테마에서 특히 튀었다. color는
            // full-bleed(디스크를 이미지로 꽉 채움)로 바꿔 디스크 자체 배경이 아예 안
            // 보이게 한다 — 이미지 원본이 정사각 풀블리드라 크롭 왜곡 없음.
            badgeDef.colorMode === 'mono' && 'bg-white',
          )}
          style={{ width: diskSize, height: diskSize }}
        >
          {/* SVG는 next/image가 dangerouslyAllowSVG 미설정 시 최적화를 거부한다(보안
              기본값) — 전역 설정을 이 배지 하나 때문에 바꾸지 않고, 기존 avatar_url과
              동형으로 raw img를 쓴다(로컬 정적 자산이라 CSP/원격도메인 우려는 없음). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={badgeDef.asset}
            alt=""
            className={badgeDef.colorMode === 'color' ? 'h-full w-full object-cover' : undefined}
            style={badgeDef.colorMode === 'mono' ? { width: markSize, height: markSize } : undefined}
          />
        </span>
      )}
      {isAgent && showInitialsBadge && (
        // 규격 실행 패키지 ② — 이니셜은 아이콘과 같은 지오메트리(디스크+ring)를 재사용하되
        // 디스크=bg-card·글자=text-foreground(중립, 브랜드색/서체 미모사 — 상표 무관).
        <span
          className="absolute -right-1 -top-1 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card font-semibold text-foreground ring-2 ring-background"
          style={{ width: diskSize, height: diskSize, fontSize: Math.round(diskSize * 0.42), letterSpacing: '-0.02em' }}
        >
          {badgeDef?.initials}
        </span>
      )}
      {isAgent && showTextBadge && (
        // story #3049(2984-S1) — AGENT_MARK_FILL_CLASS(헤어라인 border 유지·soft-fill
        // 폐지) 채택. border는 이미 있었으니 배경/텍스트색만 교체(단일 정의 재사용).
        <span
          className={cn('absolute -right-1.5 -top-1.5 rounded border border-proof-blue/40 font-bold', AGENT_MARK_FILL_CLASS)}
          style={{ fontSize: Math.max(7, Math.round(textBadgeSize * 0.55)), lineHeight: 1, padding: '2px 3px' }}
        >
          Agent
        </span>
      )}
      {isAgent && presenceStatus ? (
        <PresenceDot status={presenceStatus} size={dotSize} className="absolute -bottom-0.5 -right-0.5" />
      ) : null}
    </div>
  );

  // story #3092(2단계, 표면2) — human 아바타는 툴팁 없음(정체 모호성이 애초에 없음). agent만
  // hover 시 "{name} / Agent · {runtimeLabel}" 2줄 — runtimeType이 없으면 2번째 줄이
  // "Agent" 단독으로 자동 축약(전역 폴백, 새 텍스트 조립 없이 그대로 표현 가능).
  if (!isAgent) return avatarNode;

  const runtimeLbl = runtimeLabel(runtimeType);
  return (
    <Tooltip>
      <TooltipTrigger render={avatarNode} />
      <TooltipContent side="top">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="text-xs font-medium">{name}</span>
          {/* 툴팁 팝업 자체가 bg-foreground(반전 배경)라 text-background가 이미 고대비
              "본문" 색이다(popup 기본값 상속) — 유나 규격의 text-muted-foreground는 이
              반전 배경에서 그대로 쓰면 대비가 깨져(라이트/다크 실측 재계산: 8.49/7.11로
              AA는 통과하지만 톤 자체가 안 맞음) text-background/70(반전 배경용 동형 dim)로
              옮겨 적용 — 의도(2번째 줄=보조 정보)는 그대로, 토큰만 반전 표면에 맞게 보정. */}
          <span className="text-[11px] text-background/70">{runtimeLbl ? `Agent · ${runtimeLbl}` : 'Agent'}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
