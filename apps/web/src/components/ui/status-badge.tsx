import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const VARIANT_MAP: Record<string, 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'info'> = {
  open: 'info',
  active: 'success',
  resolved: 'secondary',
  blocked: 'destructive',
  unread: 'outline',
  draft: 'outline',
  review: 'secondary',
  completed: 'success',
  failed: 'destructive',
  running: 'info',
  queued: 'outline',
  held: 'secondary',
  backlog: 'outline',
  'ready-for-dev': 'secondary',
  'in-progress': 'info',
  'in-review': 'secondary',
  done: 'success',
};

export function StatusBadge({ status, label, interactive }: { status: string; label?: string; interactive?: boolean }) {
  const variant = VARIANT_MAP[status] ?? 'outline';
  // `interactive` turns the badge into a control affordance (cursor + chevron) — the
  // caller wraps it in a trigger. Default off, so existing read-only usages are unchanged.
  return (
    <Badge variant={variant} className={interactive ? 'cursor-pointer transition hover:brightness-95' : undefined}>
      {label ?? status}
      {interactive ? <ChevronDown aria-hidden /> : null}
    </Badge>
  );
}
