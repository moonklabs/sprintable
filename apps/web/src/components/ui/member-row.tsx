'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface MemberRowProps {
  name: string;
  email?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  emphasis?: 'default' | 'subtle';
  className?: string;
}

export function MemberRow({
  name,
  email,
  meta,
  actions,
  emphasis = 'default',
  className,
}: MemberRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border border-border px-3 py-3 text-sm',
        emphasis === 'subtle' ? 'bg-muted/20' : 'bg-muted/30',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{name}</div>
        {email ? (
          <div className="truncate text-xs text-muted-foreground">{email}</div>
        ) : null}
        {meta ? <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
