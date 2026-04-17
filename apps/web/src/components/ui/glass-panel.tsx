import * as React from 'react';
import { cn } from '@/lib/utils';

export function GlassPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(
        'rounded-3xl border border-white/10 bg-[color:var(--operator-panel)]/80 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl',
        className,
      )}
      {...props}
    />
  );
}
