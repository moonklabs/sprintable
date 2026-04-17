import * as React from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="space-y-2">
        {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[color:var(--operator-muted)]">{eyebrow}</div> : null}
        <h1 className="font-heading text-3xl font-extrabold tracking-tight text-[color:var(--operator-foreground)] md:text-5xl">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-[color:var(--operator-muted)] md:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}
