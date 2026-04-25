import * as React from 'react';
import { cn } from '@/lib/utils';

export function DocsShell({
  sidebar,
  children,
  className,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full flex-row overflow-hidden', className)}>
      <aside className="flex w-[300px] flex-shrink-0 flex-col border-r border-border/80 bg-background overflow-y-auto">
        {sidebar}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-background overflow-hidden">
        {children}
      </section>
    </div>
  );
}
