import * as React from 'react';
import { cn } from '@/lib/utils';

export function SectionCard({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="section-card"
      className={cn('rounded-2xl border border-border/80 bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  );
}

export function SectionCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('border-b border-border/80 px-5 py-4 sm:px-6', className)} {...props} />;
}

export function SectionCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4 sm:px-6', className)} {...props} />;
}
