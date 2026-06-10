'use client';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { NotificationBell } from './notification-bell';
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
      <SidebarTrigger className="mr-2 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {/* 2505d27d: presence 패널 토글(선생님 결정·FAB 대체) — Bell 옆·working-count 배지 */}
        <PresenceToggleButton />
        <NotificationBell />
      </div>
    </div>
  );
}
