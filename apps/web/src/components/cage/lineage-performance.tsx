'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { channelLabel } from '@/lib/channel-label';
import { useMaterialLineage } from '@/hooks/use-material-lineage';
import { useHookPerformances } from '@/hooks/use-hook-performances';
import { useMaterialPerformances } from '@/hooks/use-material-performances';
import { buildLineageTree, pickPrimaryMetricValue } from '@/lib/material-lineage-tree';
import type { MaterialLineageEdge, RelationKind, HookPerformanceSummary, MaterialPerformanceSnapshot } from '@/services/material-lineage';

// story #4063(E-RECIPE-1 ④ 렌더, 유나 성과 시안 v2·artifact 18fc7937 위) — 미르코 #4434
// 실 API(GET /api/v2/material-lineage·/hook-performance) + 디디 #4061 데이터층
// (buildLineageTree 등) 위. gates/[id]에 #4057 ProductionWorkbenchEvidencePanel과 나란히
// 독립 패널로 배선(PO 확認, 2026-09-19 — 전용 런페이지는 이 카드 스코프 밖).
//
// **후속(PR 9dd179582·6b7b33ebf 위, 2026-09-19) — 아래 ①②는 API가 서서 해소**:
//  ① 트리 노드별 성과 막대 — `GET .../material-performance?derived_id=`(per-variant,
//     channel_publication만) 착지, `pickPrimaryMetricValue`로 대표값 뽑아 그린다.
//     `channel_post_draft`(미발행)는 API가 항상 빈 배열이라 애초에 막대 없이 "미발행".
//  ② 노드 이름 — `master_title`(Story.title)·`channel`(denorm 컬럼) 필드 착지, 둘 다
//     null이면(fail-soft) "{kind} #{짧은id}"로 폴백(지어내지 않음, no-fiction 그대로).
//
// **③ 남은 스코프 축소(그대로 유지)**: 소재(마스터) 단위 roll-up 테이블(NORMALIZED_KEYS ×
//     D1/D7) — 마스터 전체 합산 API가 없다(훅 단위 집계뿐, D1/D7 윈도우 구분도 응답에
//     없음). 「훅 성과 요약」 스트립(훅 수·변주 수·스냅샷 수·조회수 합계)만 제공 —
//     hook_key 없는 변주는 커버 밖임을 명시(hookPerformanceSummaryScopeNote).
const RELATION_KIND_LABEL_KEY: Record<RelationKind, string> = {
  platform_cut: 'lineageRelationKindPlatformCut',
  aspect_adapt: 'lineageRelationKindAspectAdapt',
  hook_variant: 'lineageRelationKindHookVariant',
};

const RELATION_KIND_ORDER: RelationKind[] = ['platform_cut', 'aspect_adapt', 'hook_variant'];

// backend/app/services/insight_snapshots.py::NORMALIZED_KEYS 그대로 재사용(BE SoT) —
// 이 화면이 기본으로 보여줄 단일 지표. 나머지 9키는 totals에 실려 오지만 지표 세그
// 전환 UI는 이 카드 스코프 밖(후속).
const PRIMARY_METRIC_KEY = 'views';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function DerivedRef({ edge }: { edge: MaterialLineageEdge }) {
  const t = useTranslations('cage');
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {t('lineageDerivedRef', { kind: edge.derived_kind, id: shortId(edge.derived_id) })}
    </span>
  );
}

function VariantDisplayName({ edge }: { edge: MaterialLineageEdge }) {
  const tContent = useTranslations('content');
  if (edge.channel) return <span className="text-[11.5px] font-medium text-foreground">{channelLabel(edge.channel, tContent)}</span>;
  return <DerivedRef edge={edge} />;
}

function LineageVariantRow({ edge, primaryValue, maxValue }: {
  edge: MaterialLineageEdge; primaryValue: number | null; maxValue: number;
}) {
  const t = useTranslations('cage');
  const isPublished = edge.derived_kind === 'channel_publication';
  const widthPct = primaryValue !== null && maxValue > 0 ? Math.round((primaryValue / maxValue) * 100) : 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted">
      <Badge variant="secondary">{t(RELATION_KIND_LABEL_KEY[edge.relation_kind])}</Badge>
      {edge.variant_axis ? <span className="text-[11px] text-muted-foreground">{edge.variant_axis}</span> : null}
      {edge.hook_key ? <Badge variant="info">{t('lineageHookKeyRef')}</Badge> : null}
      <VariantDisplayName edge={edge} />
      {isPublished ? (
        <>
          <div className="h-1.5 w-[70px] shrink-0 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info" style={{ width: `${widthPct}%` }} />
          </div>
          <span className="w-[70px] shrink-0 text-right text-[11px] font-semibold tabular-nums text-foreground">
            {primaryValue !== null
              ? primaryValue.toLocaleString()
              : <span className="font-normal text-muted-foreground">{t('rankedHooksPending')}</span>}
          </span>
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">{t('lineageVariantUnpublished')}</span>
      )}
    </div>
  );
}

function LineageTree({ edges, snapshotsByDerivedId }: {
  edges: MaterialLineageEdge[]; snapshotsByDerivedId: Record<string, MaterialPerformanceSnapshot[]>;
}) {
  const t = useTranslations('cage');
  const nodes = buildLineageTree(edges);
  const valueByDerivedId = new Map<string, number | null>();
  for (const edge of edges) {
    if (edge.derived_kind !== 'channel_publication') continue;
    const snapshots = snapshotsByDerivedId[edge.derived_id];
    valueByDerivedId.set(edge.derived_id, snapshots ? pickPrimaryMetricValue(snapshots) : null);
  }
  const maxValue = Math.max(0, ...[...valueByDerivedId.values()].filter((v): v is number => v !== null));

  return (
    <div className="space-y-3">
      {nodes.map((node) => {
        const variants = RELATION_KIND_ORDER.flatMap((kind) => node.variantsByRelationKind[kind] ?? []);
        const masterTitle = variants.find((e) => e.master_title)?.master_title ?? null;
        return (
          <div key={node.sourceEvidenceId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-brand bg-transparent px-2 py-1.5">
              <Badge className="bg-brand/15 text-foreground">{t('lineageTreeMasterBadge')}</Badge>
              {masterTitle
                ? <span className="text-[12px] font-semibold text-foreground">{masterTitle}</span>
                : <span className="font-mono text-[11px] text-muted-foreground">{shortId(node.sourceEvidenceId)}</span>}
              <span className="text-[11px] text-muted-foreground">{t('lineageVariantCountSuffix', { n: variants.length })}</span>
            </div>
            <div className="space-y-0.5 pl-3">
              {variants.map((edge) => (
                <LineageVariantRow
                  key={edge.id} edge={edge}
                  primaryValue={valueByDerivedId.get(edge.derived_id) ?? null}
                  maxValue={maxValue}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function metricValue(summary: HookPerformanceSummary | undefined): number | null {
  return summary ? (summary.totals[PRIMARY_METRIC_KEY] ?? null) : null;
}

function RankedHookList({ hookKeys, summaries }: { hookKeys: string[]; summaries: Record<string, HookPerformanceSummary> }) {
  const t = useTranslations('cage');
  const sorted = [...hookKeys].sort((a, b) => {
    const va = metricValue(summaries[a]);
    const vb = metricValue(summaries[b]);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va;
  });
  const maxValue = Math.max(0, ...sorted.map((k) => metricValue(summaries[k]) ?? 0));

  return (
    <div className="space-y-1.5">
      {sorted.map((hookKey, i) => {
        const summary = summaries[hookKey];
        const value = metricValue(summary);
        const widthPct = value !== null && maxValue > 0 ? Math.round((value / maxValue) * 100) : 0;
        return (
          <Card key={hookKey} className="flex items-center gap-3 px-3 py-2">
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-bold ${i === 0 ? 'bg-info-tint text-foreground' : 'bg-muted text-muted-foreground'}`}>
              {i + 1}
            </span>
            <span className="flex-1 truncate text-[12.5px] font-medium text-foreground">{hookKey}</span>
            <div className="h-2 w-[120px] shrink-0 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-info" style={{ width: `${widthPct}%` }} />
            </div>
            <span className="w-[90px] shrink-0 text-right text-[12.5px] font-semibold tabular-nums text-foreground">
              {value !== null ? value.toLocaleString() : <span className="text-[11px] font-normal text-muted-foreground">{t('rankedHooksPending')}</span>}
            </span>
            <span className="w-[64px] shrink-0 text-right text-[11px] text-muted-foreground">
              {summary ? t('rankedHooksVariantCount', { n: summary.variant_count }) : null}
            </span>
          </Card>
        );
      })}
      {sorted.length === 0 ? <p className="text-[11.5px] text-muted-foreground">{t('rankedHooksNoData')}</p> : null}
    </div>
  );
}

function HookPerformanceSummaryStrip({ hookKeys, summaries }: { hookKeys: string[]; summaries: Record<string, HookPerformanceSummary> }) {
  const t = useTranslations('cage');
  const present = hookKeys.map((k) => summaries[k]).filter((s): s is HookPerformanceSummary => Boolean(s));
  if (present.length === 0) return null;
  const totalVariants = present.reduce((sum, s) => sum + s.variant_count, 0);
  const totalSnapshots = present.reduce((sum, s) => sum + s.snapshot_count, 0);
  const viewsValues = present.map((s) => s.totals[PRIMARY_METRIC_KEY]).filter((v): v is number => v !== null && v !== undefined);
  const totalViews = viewsValues.length > 0 ? viewsValues.reduce((a, b) => a + b, 0) : null;

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold text-muted-foreground">{t('hookPerformanceSummaryTitle')}</p>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">{t('hookPerformanceSummaryHooks', { n: present.length })}</Badge>
        <Badge variant="outline">{t('hookPerformanceSummaryVariants', { n: totalVariants })}</Badge>
        <Badge variant="outline">{t('hookPerformanceSummarySnapshots', { n: totalSnapshots })}</Badge>
        {totalViews !== null ? <Badge variant="info">{t('hookPerformanceSummaryViews', { n: totalViews.toLocaleString() })}</Badge> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{t('hookPerformanceSummaryScopeNote')}</p>
    </div>
  );
}

export interface LineagePerformancePanelProps {
  workItemId: string;
}

/** #4057 ProductionWorkbenchEvidencePanel과 동형 규율 — 로딩/실패/0건이면 조용히 아무것도
 * 안 그린다(omit, not placeholder). material_lineage row가 하나도 없는 work_item(레시피
 * 적용 흐름 밖 스토리 등)에서 이 패널 자체가 안 보이는 게 맞는 기본값이다. */
export function LineagePerformancePanel({ workItemId }: LineagePerformancePanelProps) {
  const t = useTranslations('cage');
  const { edges, loading, loadFailed } = useMaterialLineage(workItemId);
  const hookKeys = [...new Set(edges.map((e) => e.hook_key).filter((k): k is string => k !== null))].sort();
  const { summaries } = useHookPerformances(hookKeys);
  const publicationDerivedIds = [...new Set(
    edges.filter((e) => e.derived_kind === 'channel_publication').map((e) => e.derived_id),
  )].sort();
  const { snapshotsByDerivedId } = useMaterialPerformances(publicationDerivedIds);

  if (loading || loadFailed) return null;
  if (edges.length === 0) return null;

  return (
    <div className="space-y-4" data-testid="lineage-performance-panel">
      <p className="text-[11px] font-semibold text-muted-foreground">{t('lineagePerformanceSectionTitle')}</p>
      <Card className="space-y-2 p-3">
        <p className="text-[11px] font-semibold text-muted-foreground">{t('lineageTreeTitle')}</p>
        <LineageTree edges={edges} snapshotsByDerivedId={snapshotsByDerivedId} />
      </Card>
      {hookKeys.length > 0 ? (
        <Card className="space-y-2 p-3">
          <p className="text-[11px] font-semibold text-muted-foreground">{t('rankedHooksTitle')}</p>
          <RankedHookList hookKeys={hookKeys} summaries={summaries} />
          <HookPerformanceSummaryStrip hookKeys={hookKeys} summaries={summaries} />
        </Card>
      ) : null}
    </div>
  );
}
