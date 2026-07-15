'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  buildLoopFace, parseEpicProgress, parseHypotheses,
  type LoopFaceItem, type LoopFaceTranslator,
} from './derive-loop-face';

// story 6b707960 — 조직 브리핑 "루프" 면. S1 셸의 스켈레톤 자리에 배치 이동 없이 증분 장착
// (org-briefing-shell.tsx의 duo grid 첫 칸, 목업 Frame A 배치 1:1).
// story 64b9a879: 빈상태를 "가설을 세우면 검증까지 이어지는 과정이 여기 모입니다"로 전환하고
// C1 학습 루프 진입점(/loops)을 gentle 텍스트 링크로 자연 노출(과CTA 금지 — 버튼 아닌 링크).
// 슬러그 폴백은 app-sidebar.tsx::resourceLink()와 동형(직접 path 우선·없으면 bare path를
// 미들웨어 쿠키 기반 301이 받는다).
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
  const { orgId, orgMemberships, currentProjectSlug } = useDashboardContext();
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  const loopsHref = orgSlug && currentProjectSlug ? `/${orgSlug}/${currentProjectSlug}/loops` : '/loops';

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
    <div className="rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">{t('loopTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('loopSubject')}</span>
      </div>
      {items === null ? (
        <>
          <RowSkeleton />
          <RowSkeleton />
        </>
      ) : items.length === 0 ? (
        <div className="space-y-2 py-6 text-center">
          <p className="text-xs text-muted-foreground">{t('loopEmpty')}</p>
          <Link href={loopsHref} className="text-xs font-medium text-info hover:underline">
            {t('loopEmptyCta')} →
          </Link>
        </div>
      ) : (
        items.map((item) => <LoopRow key={item.id} item={item} />)
      )}
    </div>
  );
}
