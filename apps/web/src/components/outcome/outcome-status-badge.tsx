import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

// story #2843/#2844 — goal 전용 신값 2종(unmeasured=판정 없이 닫힘 자동마킹·unmeasurable=명시
// "측정 불가" 선언). 이전엔 이 타입에 없어 fallback(statusPending="측정 대기")으로 오표시됐다 —
// "닫혔는데 미판정"과 "아직 안 닫혀서 대기 중"은 다른 사실이라 no-fiction상 구분 필수.
export type OutcomeStatus = 'n_a' | 'pending' | 'hit' | 'miss' | 'unmeasured' | 'unmeasurable';

export function OutcomeStatusBadge({ status }: { status: OutcomeStatus }) {
  const t = useTranslations('outcomeLoop');
  if (status === 'n_a') return null;
  if (status === 'hit') return <Badge variant="success">{t('statusHit')}</Badge>;
  if (status === 'miss') return <Badge variant="chip">{t('statusMiss')}</Badge>;
  // soul-lock 동형 — miss와 마찬가지로 destructive 금지, info 톤.
  if (status === 'unmeasured') return <Badge variant="info">{t('statusUnmeasured')}</Badge>;
  if (status === 'unmeasurable') return <Badge variant="info">{t('statusUnmeasurable')}</Badge>;
  return <Badge variant="outline" className="border-dashed text-muted-foreground">{t('statusPending')}</Badge>;
}
