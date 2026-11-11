'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PresenceStatus } from '@/components/chat/presence-dot';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { CONNECTOR_BADGE_REGISTRY, getRuntimeDef, runtimeLabel } from '@/lib/runtime-capabilities';
import { initials } from '@/lib/storage/format';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export interface AvatarProps {
  /** 이니셜 «재료». null/빈 값이면 아이콘 단계로 떨어진다(없는 글자를 지어내지 않는다 — shared/avatar와 같은 계약, story #3791). */
  name: string | null;
  /** 접근성 이름(aria-label · alt · 툴팁 첫 줄). 생략하면 name. 이니셜 재료와 분리. */
  label?: string;
  avatarUrl?: string | null;
  actorType: 'human' | 'agent';
  /** px 정사각. 기본 32. */
  size?: number;
  /** agent 전용 — 연결 축 점(우하단). 사람은 항상 미표시. */
  presenceStatus?: PresenceStatus | null;
  /** agent 전용 — 활동 축(일하는 중 링 · `action` 펄스). 평소에는 링이 없다. */
  isWorking?: boolean;
  /** agent 전용 — 커넥터 정체(runtime_type 원값). 툴팁 둘째 줄 + 코너 배지에 쓰인다. */
  runtimeType?: string | null;
  /** 장식 — 같은 줄에 이름이 글로 있을 때(알림 줄 등) 눌리는 줄 안에 들어가도 되도록 초점 · 툴팁 · 읽기 이름을 모두 끈다(story 4890: 단추 안에 초점 받는 에이전트 아바타가 들어가던 문제). */
  decorative?: boolean;
  className?: string;
}

const DOT_CLASS: Record<PresenceStatus, string> = {
  online: 'bg-ds-done',
  idle: 'bg-ds-ink-3',
  offline: 'bg-ds-background ring-1 ring-inset ring-ds-line-control',
};
const DOT_LABEL_KEY: Record<PresenceStatus, string> = {
  online: 'presenceOnline',
  idle: 'presenceIdle',
  offline: 'presenceOffline',
};

/**
 * UI-3(a9d56577) — 새 Avatar(ds 토큰). 현행 `shared/avatar.tsx`의 기능을 그대로 잇고 모양 · 색만 새 판으로 옮긴다.
 *
 * - **모양은 지금 약속 그대로**(PO 11-10): 에이전트 = 원 · 사람 = 사각(둥근 모서리 + 테두리). 시안 그림은 명세가 아니다.
 * - **사진이 기본**: 사진 → 이니셜 → 아이콘 3단 폴백 · 사진 로드 실패(onError)도 다음 단계로 폴백.
 * - 에이전트 상시 정적 링은 없다(모양이 이미 구분한다). **일하는 중 링**(활동 축)과 **연결 점**(연결 축)은 두 축을 합치지 않고 따로 둔다.
 * - 코너 배지: 커넥터 아이콘 · 이니셜(≥28px) / 그 밖에 >40px에서만 «에이전트» 글자 배지(≤40px는 툴팁 · 꼬리표가 신호를 나름).
 * - 에이전트만 hover/focus 툴팁(이름 · «에이전트 · 런타임»). 사람은 툴팁 없음.
 * 색은 `ds-*` 뜻 이름만 쓴다.
 */
export function Avatar({
  name,
  label,
  avatarUrl,
  actorType,
  size = 32,
  presenceStatus,
  isWorking = false,
  runtimeType = null,
  decorative = false,
  className,
}: AvatarProps) {
  const t = useTranslations('chats');
  const a11yName = (label?.trim() ? label : undefined) ?? (name?.trim() ? name : undefined);
  const isAgent = actorType === 'agent';
  const iconSize = Math.round(size * 0.5);
  const initSize = Math.round(size * 0.4);
  // shared/avatar와 같은 눈금: 40px 미만 10px · 이상 12px(presence-dot의 size-2.5 / size-3) — 작은 점이 상태를 못 읽게 줄이지 않는다.
  const dotSize = size >= 40 ? 12 : 10;

  const runtimeDef = getRuntimeDef(runtimeType);
  const badgeDef = runtimeDef ? CONNECTOR_BADGE_REGISTRY[runtimeDef.key] : null;
  const minIconSize = badgeDef?.kind === 'icon' ? (badgeDef.minIconSize ?? 28) : 28;
  const showIconBadge = badgeDef?.kind === 'icon' && size >= minIconSize;
  const showInitialsBadge =
    badgeDef?.kind === 'initials' || (badgeDef?.kind === 'icon' && !showIconBadge && !!badgeDef.initials && size >= 28);
  const showTextBadge = !showIconBadge && !showInitialsBadge && size > 40;
  const diskSize = Math.min(30, Math.max(16, Math.round(size * 0.4)));
  const markSize = Math.round(diskSize * 0.68);
  const textBadgeSize = Math.max(14, Math.round(size * 0.32));

  // 사진 로드 실패(삭제 · 서명 만료 · 환경간 버킷 불일치)를 onError로 감지해 다음 단계로 폴백한다. 사진 주소가 바뀌면 다시 시도한다.
  const [imgError, setImgError] = useState(false);
  const [lastAvatarUrl, setLastAvatarUrl] = useState(avatarUrl);
  if (avatarUrl !== lastAvatarUrl) {
    setLastAvatarUrl(avatarUrl);
    setImgError(false);
  }
  const showImage = !!avatarUrl && !imgError;

  const avatarNode = (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      tabIndex={isAgent && !decorative ? 0 : undefined}
      aria-hidden={decorative ? true : undefined}
      data-actor={actorType}
    >
      <div
        data-shape={isAgent ? 'circle' : 'square'}
        className={cn(
          'h-full w-full overflow-hidden',
          isAgent ? 'rounded-full' : 'rounded-ds-control border border-ds-line-control',
          isAgent && isWorking && 'ring-2 ring-ds-action ring-offset-1 ring-offset-ds-background motion-safe:animate-ds-pulse',
        )}
      >
        {showImage ? (
          // avatar_url은 avatar 전용 GCS 버킷의 임의 서빙 도메인이라 next/image 원격 패턴에 사전 등록이 안 됨 — shared/avatar와 같은 이유로 raw img.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={a11yName ?? ''} className="h-full w-full object-cover" onError={() => setImgError(true)} />
        ) : name?.trim() ? (
          <span
            className="flex h-full w-full items-center justify-center bg-ds-surface-high font-semibold text-ds-ink-2"
            style={{ fontSize: initSize }}
            role={a11yName ? 'img' : undefined}
            aria-label={a11yName}
            suppressHydrationWarning
          >
            {initials(name)}
          </span>
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-ds-surface-high text-ds-ink-3" role={a11yName ? 'img' : undefined} aria-label={a11yName}>
            <Icon name={isAgent ? 'smart_toy' : 'person'} size={iconSize} />
          </span>
        )}
      </div>

      {isAgent && showIconBadge && badgeDef?.asset && (
        <span
          className={cn(
            'absolute -right-1 -top-1 flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-2 ring-ds-background',
            badgeDef.colorMode === 'mono' && 'bg-white',
          )}
          style={{ width: diskSize, height: diskSize }}
        >
          {/* 커넥터 배지 SVG는 next/image가 dangerouslyAllowSVG 미설정 시 거부 — shared/avatar와 같이 raw img(로컬 정적 자산). */}
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
        <span
          className="absolute -right-1 -top-1 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ds-surface font-semibold text-ds-ink ring-2 ring-ds-background"
          style={{ width: diskSize, height: diskSize, fontSize: Math.round(diskSize * 0.42), letterSpacing: '-0.02em' }}
        >
          {badgeDef?.initials}
        </span>
      )}
      {isAgent && showTextBadge && (
        <span
          className="absolute -right-1.5 -top-1.5 rounded-ds-tag border border-ds-line bg-ds-surface-high font-semibold text-ds-ink-3"
          style={{ fontSize: Math.max(7, Math.round(textBadgeSize * 0.55)), lineHeight: 1, padding: '2px 3px' }}
        >
          {t('agent')}
        </span>
      )}
      {isAgent && presenceStatus ? (
        <span
          role="img"
          aria-label={t(DOT_LABEL_KEY[presenceStatus])}
          data-presence={presenceStatus}
          className={cn('absolute -bottom-0.5 -right-0.5 inline-block rounded-full border-2 border-ds-background', DOT_CLASS[presenceStatus])}
          style={{ width: dotSize, height: dotSize }}
        />
      ) : null}
    </div>
  );

  if (!isAgent || decorative) return avatarNode;

  const runtimeLbl = runtimeLabel(runtimeType);
  return (
    <Tooltip>
      <TooltipTrigger render={avatarNode} />
      <TooltipContent side="top">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="text-ds-small font-semibold">{a11yName}</span>
          <span className="text-ds-mono-md opacity-70">{runtimeLbl ? `${t('agent')} · ${runtimeLbl}` : t('agent')}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
