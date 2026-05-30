import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

export type OutcomeStatus = 'n_a' | 'pending' | 'hit' | 'miss';

export function OutcomeStatusBadge({ status }: { status: OutcomeStatus }) {
  const t = useTranslations('outcomeLoop');
  if (status === 'n_a') return null;
  if (status === 'hit') return <Badge variant="success">{t('statusHit')}</Badge>;
  if (status === 'miss') return <Badge variant="chip">{t('statusMiss')}</Badge>;
  return <Badge variant="outline" className="border-dashed text-muted-foreground">{t('statusPending')}</Badge>;
}
