'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Brain } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { OutcomeBadge } from '@/components/loops/outcome-badge';

/** E-LOOP-LEDGER S13 — GET /loops/{id}/context-pack 응답 shape(handoff §3, PO-locked). */
interface ContextPackDecision {
  chosen: { label: string; reason: string };
  rejected: { label: string; reason: string }[];
}
interface ContextPackOutcome {
  hypothesis_status: 'verified' | 'falsified';
  metric: string;
  actual: number;
  target: number;
  direction: 'up' | 'down';
}
interface ContextPackItem {
  entity_type: 'loop' | 'hypothesis' | 'decision';
  entity_id: string;
  similarity: number;
  goal: string;
  decision: ContextPackDecision | null;
  outcome: ContextPackOutcome | null;
  href: string;
}
interface ContextPackResponse {
  items: ContextPackItem[];
  embed_available: boolean;
}

function ContextPackCard({ item }: { item: ContextPackItem }) {
  const t = useTranslations('loops');
  const entityLabel = t(`entityType${item.entity_type.charAt(0).toUpperCase()}${item.entity_type.slice(1)}` as 'entityTypeLoop');
  const viewLabel = item.entity_type === 'hypothesis' ? t('contextPackViewHypothesis') : t('contextPackViewLoop');

  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Badge variant="chip" className="text-[9px] uppercase">{entityLabel}</Badge>
            {item.outcome ? <OutcomeBadge hypothesisStatus={item.outcome.hypothesis_status} className="text-[9px]" /> : null}
          </div>
          <p className="text-sm font-semibold text-foreground">{item.goal}</p>
        </div>
        <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-muted-foreground">
          {t('contextPackSimilarity', { value: item.similarity.toFixed(2) })}
        </span>
      </div>

      {item.decision ? (
        <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2.5 text-[11.5px]">
          <div>
            <Badge variant="success" className="mr-1.5 text-[9px]">{t('contextPackChosenLabel')}</Badge>
            <span className="font-medium text-foreground">{item.decision.chosen.label}</span>
            <span className="text-muted-foreground"> — {item.decision.chosen.reason}</span>
          </div>
          {item.decision.rejected.map((r, i) => (
            <div key={i}>
              <Badge variant="chip" className="mr-1.5 text-[9px]">{t('contextPackRejectedLabel')}</Badge>
              <span className="font-medium text-foreground">{r.label}</span>
              <span className="text-muted-foreground"> — {r.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
        {item.outcome ? (
          <span>
            {t('contextPackOutcomeLine', {
              metric: item.outcome.metric,
              actual: item.outcome.actual,
              arrow: item.outcome.direction === 'up' ? '↑' : '↓',
              target: item.outcome.target,
            })}
          </span>
        ) : <span />}
        <Link href={item.href} className="shrink-0 font-semibold text-primary hover:underline">
          {viewLabel} →
        </Link>
      </div>
    </div>
  );
}

/**
 * S13 — "과거 loop에서 학습" 패널. loop 상세/brief 뷰 부속 섹션(handoff §1).
 * S12(GET /loops/{id}/context-pack) 착지 전이라도 계약 shape은 PO-locked(목업이 정의) —
 * BFF는 이미 준비돼 있어 S12 머지되면 이 컴포넌트는 변경 없이 라이브 연결된다.
 */
export function ContextPackPanel({ loopId }: { loopId: string }) {
  const t = useTranslations('loops');
  const [data, setData] = useState<ContextPackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUnavailable(false);
    void (async () => {
      try {
        const res = await fetch(`/api/loops/${loopId}/context-pack`);
        if (cancelled) return;
        if (!res.ok) { setUnavailable(true); return; }
        const json = (await res.json()) as ContextPackResponse;
        setData(json);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loopId]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border bg-info-tint/40 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Brain className="size-4 text-info" aria-hidden />
            <span className="text-sm font-bold text-foreground">{t('contextPackTitle')}</span>
          </div>
          {!loading && !unavailable && data && data.items.length > 0 ? (
            <Badge variant="outline">{t('contextPackCount', { count: data.items.length })}</Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('contextPackSubtitle')}</p>
      </div>

      <div className="space-y-2.5 p-3">
        {loading ? (
          <>
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </>
        ) : unavailable || (data && !data.embed_available) ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('contextPackEmbedUnavailable')}</p>
        ) : !data || data.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('contextPackEmpty')}</p>
        ) : (
          data.items.map((item) => <ContextPackCard key={`${item.entity_type}-${item.entity_id}`} item={item} />)
        )}
      </div>
    </div>
  );
}
