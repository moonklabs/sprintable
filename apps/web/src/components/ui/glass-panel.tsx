import * as React from 'react';
import { cn } from '@/lib/utils';

export function GlassPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(
        'rounded-2xl border border-border/80 bg-card/95 text-card-foreground shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/88',
        className,
      )}
      {...props}
    />
  );
}
