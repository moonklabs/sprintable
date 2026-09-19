'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useMaterialLineage } from '@/hooks/use-material-lineage';
import { useHookPerformances } from '@/hooks/use-hook-performances';
import { buildLineageTree } from '@/lib/material-lineage-tree';
import type { MaterialLineageEdge, RelationKind, HookPerformanceSummary } from '@/services/material-lineage';

// story #4063(E-RECIPE-1 ④ 렌더, 유나 성과 시안 v2·artifact 18fc7937 위) — 미르코 #4434
// 실 API(GET /api/v2/material-lineage·/hook-performance) + 디디 #4061 데이터층
// (buildLineageTree 등) 위. gates/[id]에 #4057 ProductionWorkbenchEvidencePanel과 나란히
// 독립 패널로 배선(PO 확認, 2026-09-19 — 전용 런페이지는 이 카드 스코프 밖).
//
// **시안 대비 스코프 축소 3건(실 API에 없는 값은 지어내지 않는다 — no-fiction, 유나에 플래그)**:
//  ① 트리 노드별 성과 막대(시안 "142,800"류) — MaterialLineageEdgeView엔 구조 필드뿐이고
//     변주(derived_id) 단위 성과를 조회하는 API가 없다(오직 hook_key 단위 집계만 존재).
//     그래서 트리는 구조만 그린다 — 훅이 걸린 변주엔 훅 배지만 달아 아래 랭킹과 연결한다.
//  ② 노드 이름(시안 "가을 신상 15초 컷") — evidence/변주 어느 쪽도 사람이 읽을 제목을 이
//     응답에 안 담아(source_evidence_id/derived_id는 uuid뿐) "{kind} #{짧은id}"로 대체.
//  ③ 소재(마스터) 단위 roll-up 테이블(NORMALIZED_KEYS × D1/D7) — 마스터 전체 합산 API가
//     없다(훅 단위 집계뿐이며 D1/D7 윈도우 구분도 응답에 없음). 그 대신 「훅 성과 요약」
//     스트립(훅 수·변주 수·스냅샷 수·조회수 합계)만 제공 — hook_key 없는 변주는 커버 밖임을
//     명시(hookPerformanceSummaryScopeNote).
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

function LineageVariantRow({ edge }: { edge: MaterialLineageEdge }) {
  const t = useTranslations('cage');
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted">
      <Badge variant="secondary">{t(RELATION_KIND_LABEL_KEY[edge.relation_kind])}</Badge>
      {edge.variant_axis ? <span className="text-[11px] text-muted-foreground">{edge.variant_axis}</span> : null}
      {edge.hook_key ? <Badge variant="info">{t('lineageHookKeyRef')}</Badge> : null}
      <DerivedRef edge={edge} />
    </div>
  );
}

function LineageTree({ edges }: { edges: MaterialLineageEdge[] }) {
  const t = useTranslations('cage');
  const nodes = buildLineageTree(edges);
  return (
    <div className="space-y-3">
      {nodes.map((node) => {
        const variantCount = RELATION_KIND_ORDER.reduce(
          (sum, kind) => sum + (node.variantsByRelationKind[kind]?.length ?? 0), 0,
        );
        return (
          <div key={node.sourceEvidenceId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-brand bg-transparent px-2 py-1.5">
              <Badge className="bg-brand/15 text-foreground">{t('lineageTreeMasterBadge')}</Badge>
              <span className="font-mono text-[11px] text-muted-foreground">{shortId(node.sourceEvidenceId)}</span>
              <span className="text-[11px] text-muted-foreground">{t('lineageVariantCountSuffix', { n: variantCount })}</span>
            </div>
            <div className="space-y-0.5 pl-3">
              {RELATION_KIND_ORDER.flatMap((kind) => node.variantsByRelationKind[kind] ?? []).map((edge) => (
                <LineageVariantRow key={edge.id} edge={edge} />
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

  if (loading || loadFailed) return null;
  if (edges.length === 0) return null;

  return (
    <div className="space-y-4" data-testid="lineage-performance-panel">
      <p className="text-[11px] font-semibold text-muted-foreground">{t('lineagePerformanceSectionTitle')}</p>
      <Card className="space-y-2 p-3">
        <p className="text-[11px] font-semibold text-muted-foreground">{t('lineageTreeTitle')}</p>
        <LineageTree edges={edges} />
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
