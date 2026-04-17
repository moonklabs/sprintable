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

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const variant = VARIANT_MAP[status] ?? 'outline';
  return <Badge variant={variant}>{label ?? status}</Badge>;
}
