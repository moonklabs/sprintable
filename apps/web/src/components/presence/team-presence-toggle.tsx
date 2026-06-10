'use client';

import { createContext, useContext } from 'react';
import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';

// 2505d27d: presence 패널 토글을 헤더(TopBar)서 제어하기 위한 context.
// 패널 state(useContextualPanelState)는 ScrollShell 소유 → provider로 TopBar에 toggle/count/open 공급.
// (선생님 결정: FAB→상단 헤더 people 토글. composer 충돌0·발견성↑.)
interface TeamPresenceToggleValue {
  toggle: () => void;
  workingCount: number;
  open: boolean;
}

const TeamPresenceToggleContext = createContext<TeamPresenceToggleValue | null>(null);

export const TeamPresenceToggleProvider = TeamPresenceToggleContext.Provider;

export function useTeamPresenceToggle(): TeamPresenceToggleValue | null {
  return useContext(TeamPresenceToggleContext);
}

/**
 * 헤더(TopBar·NotificationBell 옆) presence 토글 버튼 — people 아이콘 + working-count 배지(bell unread 패턴 일관).
 * provider 밖(컨텍스트 없음)이면 미렌더(graceful).
 */
export function PresenceToggleButton() {
  const t = useTranslations('presence');
  const ctx = useTeamPresenceToggle();
  if (!ctx) return null;
  const { toggle, workingCount, open } = ctx;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={workingCount > 0 ? t('fabLabelWorking', { count: workingCount }) : t('panelTitle')}
      aria-pressed={open}
      title={t('panelTitle')}
      className={cn(
        'relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        open && 'bg-muted/60 text-foreground',
      )}
    >
      <Users className="size-4" />
      {workingCount > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold tabular-nums text-brand-foreground"
          aria-hidden
        >
          {workingCount}
        </span>
      ) : null}
    </button>
  );
}
