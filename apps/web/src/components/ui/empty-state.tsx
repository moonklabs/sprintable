import { cn } from '@/lib/utils';

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-2xl bg-muted/50 px-6 py-10 text-center', className)}>
      <div className="mx-auto max-w-md space-y-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
        {action ? <div className="pt-2.5">{action}</div> : null}
      </div>
    </div>
  );
}
