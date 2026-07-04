import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type LoopStatus =
  | 'draft'
  | 'briefing'
  | 'generating'
  | 'deciding'
  | 'executing'
  | 'measuring'
  | 'closed'
  | 'abandoned';

/**
 * 8-state loop status badge (E-LOOP-LEDGER S6 — handoff §3).
 * draft=muted outline·briefing/generating=info(준비중)·deciding=default(강조 — 사람 액션 필요)·
 * executing/measuring=warning(진행중)·closed=success·abandoned=chip(종료·최저 강조).
 * hypothesis-status-badge.tsx와 동형(도메인 전용 컴포넌트로 분리 — 8-state 각기 다른 색 위계라
 * 공용 status-badge.tsx VARIANT_MAP 재사용 시 오염 위험).
 */
export function LoopStatusBadge({ status, className }: { status: LoopStatus; className?: string }) {
  const t = useTranslations('loops');
  const labelKey = `status${status.charAt(0).toUpperCase()}${status.slice(1)}` as 'statusDraft';
  const label = t(labelKey);

  if (status === 'draft') {
    return (
      <Badge variant="outline" className={cn('border-dashed text-muted-foreground', className)}>
        {label}
      </Badge>
    );
  }
  if (status === 'briefing' || status === 'generating') {
    return <Badge variant="info" className={className}>{label}</Badge>;
  }
  if (status === 'deciding') {
    return <Badge variant="default" className={cn('font-semibold', className)}>{label}</Badge>;
  }
  if (status === 'executing' || status === 'measuring') {
    return <Badge variant="warning" className={className}>{label}</Badge>;
  }
  if (status === 'closed') {
    return <Badge variant="success" className={cn('font-semibold', className)}>{label}</Badge>;
  }
  return <Badge variant="chip" className={cn('opacity-60', className)}>{label}</Badge>;
}
