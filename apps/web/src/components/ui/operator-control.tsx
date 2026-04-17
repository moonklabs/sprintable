import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

const operatorControlClassName = 'rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] outline-none transition focus:border-[color:var(--operator-primary)]/35';

export function OperatorInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input className={cn(operatorControlClassName, 'h-10 bg-[color:var(--operator-surface-soft)]', className)} {...props} />;
}

export function OperatorTextarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(operatorControlClassName, 'min-h-[96px] w-full resize-y', className)}
      {...props}
    />
  );
}

export function OperatorSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(operatorControlClassName, 'h-10 w-full pr-8', className)}
      {...props}
    />
  );
}

export { operatorControlClassName };
