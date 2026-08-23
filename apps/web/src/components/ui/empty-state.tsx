import { cn } from '@/lib/utils';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    // story #2969 §2 C행(doc proofline-system-layer-2969, PR-6) — rounded-2xl(§1.1 "카드·
    // 인라인 표면에서 퇴역")→rounded-lg(4px)로 크리스프화.
    <div className={cn('rounded-lg bg-muted/50 px-6 py-10 text-center', className)}>
      <div className="mx-auto max-w-md space-y-3">
        {icon ? <div className="mb-3 flex justify-center text-muted-foreground">{icon}</div> : null}
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
        {action ? <div className="pt-2.5">{action}</div> : null}
      </div>
    </div>
  );
}
