import * as React from 'react';
import { cn } from '@/lib/utils';

export function SectionCard({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="section-card"
      className={cn('rounded-3xl border border-white/10 bg-[color:var(--operator-panel)]/82 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl', className)}
      {...props}
    />
  );
}

export function SectionCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('border-b border-white/8 px-5 py-4', className)} {...props} />;
}

export function SectionCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}
