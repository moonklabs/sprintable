import * as React from 'react';
import { cn } from '@/lib/utils';

export function GlassPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
