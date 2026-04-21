import * as React from 'react';
import { cn } from '@/lib/utils';
import { GlassPanel } from '@/components/ui/glass-panel';

export function DocsShell({
  sidebar,
  children,
  className,
  mobileSidebarOpen = false,
  onMobileSidebarOpenChange,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  mobileSidebarOpen?: boolean;
  onMobileSidebarOpenChange?: (open: boolean) => void;
}) {
  return (
    <>
      <div className={cn('grid gap-3 lg:gap-5 lg:grid-cols-[300px_minmax(0,1fr)]', className)}>
        <GlassPanel className="hidden min-w-0 overflow-y-auto border-white/8 bg-[color:var(--operator-surface-soft)]/75 shadow-sm lg:block">
          {sidebar}
        </GlassPanel>
        <GlassPanel className="flex min-h-0 flex-1 flex-col overflow-hidden shadow-sm">
          {children}
        </GlassPanel>
      </div>

      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close docs sidebar"
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            onClick={() => onMobileSidebarOpenChange?.(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[min(85vw,20rem)] p-3">
            <GlassPanel className="flex h-full min-h-0 flex-col border-white/8 bg-[color:var(--operator-surface-soft)]/92 shadow-[0_24px_80px_rgba(0,0,0,0.42)]">
              {sidebar}
            </GlassPanel>
          </div>
        </div>
      ) : null}
    </>
  );
}
