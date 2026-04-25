'use client';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useTopBar } from './top-bar-context';

interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps) {
  const { title, actions } = useTopBar();
  return (
    <div className={cn('flex h-12 shrink-0 items-center gap-2 border-b px-4', className)}>
      <SidebarTrigger className="mr-2 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
