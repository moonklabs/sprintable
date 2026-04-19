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
      className={cn(operatorControlClassName, 'h-10 pr-8 appearance-none', className)}
      {...props}
    />
  );
}

export { operatorControlClassName };
