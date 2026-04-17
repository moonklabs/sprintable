import * as React from 'react';
import { cn } from '@/lib/utils';

export function OperatorStatCard({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-2xl border border-white/8 bg-white/5 p-4', className)}>
      <div className="text-xs text-[color:var(--operator-muted)]">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-[color:var(--operator-foreground)]">{value}</div>
      {hint ? <div className="mt-2 text-xs text-[color:var(--operator-muted)]">{hint}</div> : null}
    </div>
  );
}
