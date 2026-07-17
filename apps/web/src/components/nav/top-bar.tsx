'use client';

import { cn } from '@/lib/utils';
import { NotificationBell } from './notification-bell';
import { WhatsNewButton } from '@/components/release-notes/whats-new-button';
import { PresenceToggleButton } from '@/components/presence/team-presence-toggle';
import { useTopBar } from './top-bar-context';

interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps) {
  const { title, actions, hidden } = useTopBar();
  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b px-4',
        'sticky top-0 z-30 bg-background transition-transform',
        '[transition-duration:var(--gnb-hide-duration)]',
        '[transition-timing-function:var(--gnb-hide-easing)]',
        hidden && '-translate-y-full',
        className,
      )}
    >
      {/* story #1958: 모바일 햄버거 트리거 제거 — 하단 탭바(MobileTabBar)가 <1024 내비게이션을
          대신한다(blueprint §3.2 "모바일 사이드바 Sheet/햄버거 폐기" 방향, 오르테가군 확定). */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {/* 2505d27d: presence 패널 토글(선생님 결정·FAB 대체) — Bell 옆·working-count 배지 */}
        <PresenceToggleButton />
        <WhatsNewButton />
        <NotificationBell />
      </div>
    </div>
  );
}
