'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  buildLoopFace, parseEpicProgress, parseHypotheses,
  type LoopFaceItem, type LoopFaceTranslator,
} from './derive-loop-face';

// story 6b707960 — 조직 브리핑 "루프" 면. S1 셸의 스켈레톤 자리에 배치 이동 없이 증분 장착
// (org-briefing-shell.tsx의 duo grid 첫 칸, 목업 Frame A 배치 1:1).
const REFRESH_MS = 60_000;

async function loadLoopFace(projectId: string, t: LoopFaceTranslator): Promise<LoopFaceItem[]> {
  const [hyp, overview] = await Promise.all([
    fetch(`/api/hypotheses?project_id=${projectId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/dashboard/overview').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return buildLoopFace(parseHypotheses(hyp), parseEpicProgress(overview), t);
}

function KindBadge({ kind, label }: { kind: LoopFaceItem['kind']; label: string }) {
  const variant = kind === 'achieved' ? 'success' : kind === 'next' ? 'chip' : 'info';
  return <Badge variant={variant} className="shrink-0 whitespace-nowrap">{label}</Badge>;
}

function LoopRow({ item }: { item: LoopFaceItem }) {
  return (
    <div className={cn('space-y-2 border-t border-border py-3 first:border-t-0 first:pt-0', item.dimmed && 'opacity-50')}>
      <p className="text-[13px] font-medium leading-snug text-foreground">{item.statement}</p>
      <KindBadge kind={item.kind} label={item.kindLabel} />
      {item.trajectoryPct !== null ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full border border-border/60 bg-muted/50">
            <div className="h-full rounded-full bg-info transition-all" style={{ width: `${item.trajectoryPct}%` }} />
          </div>
          {item.trajectoryLabel ? <p className="text-[11px] text-muted-foreground">{item.trajectoryLabel}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="space-y-1.5 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      <div className="h-2 w-16 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

export function LoopFace({ projectId }: { projectId: string }) {
  const t = useTranslations('orgBriefing');
  const [items, setItems] = useState<LoopFaceItem[] | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await loadLoopFace(projectId, t);
      setItems(result);
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [projectId, t]);

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('loopTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('loopSubject')}</span>
      </div>
      {items === null ? (
        <>
          <RowSkeleton />
          <RowSkeleton />
        </>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t('loopEmpty')}</p>
      ) : (
        items.map((item) => <LoopRow key={item.id} item={item} />)
      )}
    </div>
  );
}
