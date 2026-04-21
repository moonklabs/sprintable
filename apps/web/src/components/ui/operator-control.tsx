import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

const operatorControlClassName = 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors';

export function OperatorInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input className={cn(operatorControlClassName, 'h-10', className)} {...props} />;
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
      className={cn(
        operatorControlClassName,
        "h-10 cursor-pointer appearance-none rounded-xl border-border/80 bg-[image:linear-gradient(45deg,transparent_50%,currentColor_50%),linear-gradient(135deg,currentColor_50%,transparent_50%)] bg-[position:calc(100%-18px)_calc(50%-2px),calc(100%-12px)_calc(50%-2px)] bg-[size:6px_6px,6px_6px] bg-no-repeat pr-10 text-foreground shadow-sm hover:border-primary/40 hover:bg-muted/30",
        className,
      )}
      {...props}
    />
  );
}

export { operatorControlClassName };
