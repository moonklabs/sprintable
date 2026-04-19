import * as React from 'react';
import { cn } from '@/lib/utils';

export function SectionCard({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="section-card"
      className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  );
}

export function SectionCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('border-b border-border px-5 py-4', className)} {...props} />;
}

export function SectionCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}
