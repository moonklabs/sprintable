'use client';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

interface TopBarProps {
  children?: React.ReactNode;
  className?: string;
}

export function TopBar({ children, className }: TopBarProps) {
  return (
    <div className={cn("flex h-12 shrink-0 items-center border-b px-4", className)}>
      <SidebarTrigger className="mr-2 md:hidden" />
      {children}
    </div>
  );
}
