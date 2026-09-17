'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 「연결·규칙」 v3의 세 섹션(B·C·D)이
 * 각자 독립 fetch·독립 실패를 가진다(AgentManagementTab의 loading/loadError/retryKey
 * 패턴과 동형, 한 섹션 실패가 다른 섹션을 막지 않는다). 상태 3종(Skeleton·빈·보이는
 * 「다시 시도」)을 세 섹션이 공유하는 자리 — 문구·마크업 드리프트 방지.
 */
export function ConnectRulesV3SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true" data-testid="connect-rules-v3-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}

export function ConnectRulesV3SectionError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('connectRulesV3');
  const tc = useTranslations('common');
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-3 py-8 text-center">
      <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>{tc('retry')}</Button>
    </div>
  );
}

export function ConnectRulesV3SectionEmpty({ title }: { title: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
    </div>
  );
}
