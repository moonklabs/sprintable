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
    <div className={cn('rounded-md border border-border bg-muted/30 p-4', className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-foreground">{value}</div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
