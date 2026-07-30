'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { GlanceHero } from '@/components/glance/glance-hero';
import { ExceptionStream } from '@/components/glance/exception-stream';
import { toExceptionQueueItems, type BeAttentionSignal, type ExceptionLabels } from '@/components/glance/derive-exception-signals';
import { loadGlanceData, type GlanceData } from '@/components/glance/load-glance-data';
import { useIsMobile } from '@/hooks/use-mobile';
import { FlowLane } from '@/components/flow/flow-lane';
import { FlowCanvas } from '@/components/flow/flow-canvas';
import { deriveFlowLaneRows } from '@/components/flow/derive-flow';

interface FlowPageClientProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

type FlowView = 'flow' | 'kanban';

function parseView(raw: string | null): FlowView {
  return raw === 'kanban' ? 'kanban' : 'flow';
}

/**
 * story #2224(IA v2.2 §7-3, 유나 정정 2026-07-30) — 통합 화면. ①초점 스트립(GlanceHero, A타입
 * 재사용) ②관제 서랍(ExceptionStream, A타입 재사용) 은 보기와 무관하게 항상 고정 — "전면에서
 * 내린다"는 뜻이 이것이다(칸반으로 전환해도 이 둘은 그대로 남는다). 보기 전환은 갈래 캔버스의
 * 머리(③)에만 있고, `?view=kanban` 쿼리파라미터가 정본(URL이 상태를 들고 있어 새로고침·공유
 * 가능·전환이 "다른 데로 가는 것"처럼 안 느껴짐). 칸반 자체는 §1-C(보기로 이전) — kanban-board.tsx
 * 를 새로 그리지 않고 그대로 마운트한다.
 */
export default function FlowPageClient({ projectId, wsSlug, projSlug }: FlowPageClientProps) {
  const t = useTranslations('flow');
  const tGlance = useTranslations('glance');
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = parseView(searchParams.get('view'));
  // 유나 지적(2026-07-30) — 모바일은 갈래|칸반 세그를 그리지 않는다(#2225의 갈래·막힘·멈춤
  // 탭이 그 자리를 대신함). CSS로 숨기면 DOM에 둘 다 남아 스크린리더·탭 순서가 겹친다(#2225
  // AC3와 같은 규율) — useIsMobile로 렌더 자체를 가른다. `?view=`는 모바일에서도 URL 정본
  // 그대로라 세그가 없어도 주소로 칸반 진입은 가능하다.
  const isMobile = useIsMobile();

  const [data, setData] = useState<GlanceData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback((cancelledRef: { cancelled: boolean }) => {
    setLoading(true);
    void (async () => {
      try {
        const result = await loadGlanceData(projectId);
        if (cancelledRef.cancelled) return;
        setData(result);
      } catch {
        if (cancelledRef.cancelled) return;
        setData(null);
      } finally {
        if (!cancelledRef.cancelled) setLoading(false);
      }
    })();
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const cancelledRef = { cancelled: false };
    fetchData(cancelledRef);
    return () => { cancelledRef.cancelled = true; };
  }, [projectId, fetchData]);

  const setView = useCallback((next: FlowView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'flow') params.delete('view');
    else params.set('view', next);
    const qs = params.toString();
    router.push(`/${wsSlug}/${projSlug}/flow${qs ? `?${qs}` : ''}`);
  }, [router, searchParams, wsSlug, projSlug]);

  const exceptionItems = useMemo(() => {
    if (!data) return [];
    const labels: ExceptionLabels = {
      kind: {
        gate_pending: tGlance('exceptionKindGatePending'),
        blocked: tGlance('exceptionKindBlocked'),
        merge_ready: tGlance('exceptionKindMergeReady'),
      },
      action: {
        gate_pending: tGlance('exceptionActionGatePending'),
        blocked: tGlance('exceptionActionBlocked'),
        merge_ready: tGlance('exceptionActionMergeReady'),
      },
    };
    return toExceptionQueueItems(data.attentionSignals as BeAttentionSignal[], labels);
  }, [data, tGlance]);

  const laneRows = useMemo(() => deriveFlowLaneRows(data?.roadmap ?? []), [data]);
  const activeEpicId = useMemo(() => data?.roadmap.find((e) => e.roadmapStatus === 'active')?.id ?? null, [data]);

  // #2221(구조화된 연결 간선) 미착지 — 실제 배열 길이 0에서 나온 값이지 리터럴이 아니다.
  // #2221이 착지해 실 간선 배열을 내려주면 이 상수를 그 배열의 length로 바꾸는 것으로 끝난다.
  const edgeCount = 0;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />

      <div className="space-y-4 p-4">
        {/* ① 초점 스트립 — 보기 무관 고정(IA §7-3 유나 정정 ③) */}
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
        ) : data?.heroStory ? (
          <GlanceHero story={data.heroStory} memberMap={data.memberMap} envelope={data.heroEnvelope} />
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {tGlance('heroEmpty')}
          </p>
        )}

        {/* ② 갈래 캔버스의 머리 — 보기 전환. 여기 둘만(§7-3): 갈래 | 칸반. 모바일은 #2225의
            갈래·막힘·멈춤 탭이 이 자리를 대신하므로 세그를 그리지 않는다(isMobile===undefined인
            최초 렌더에서도 안전하게 숨김 — 하이드레이션 후 실값으로 켜진다). */}
        {isMobile ? null : (
          <div className="flex items-center gap-1 border-b border-border pb-2">
            <button
              type="button"
              onClick={() => setView('flow')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'flow' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t('viewFlow')}
            </button>
            <button
              type="button"
              onClick={() => setView('kanban')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'kanban' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t('viewKanban')}
            </button>
          </div>
        )}

        {view === 'kanban' ? (
          <KanbanBoard projectId={projectId} wsSlug={wsSlug} projSlug={projSlug} />
        ) : (
          // IA §2 유나 추가 지적(2026-07-30) — 좌 레인은 "블록 하나"가 아니라 "고정 열 + 가로
          // 스크롤 캔버스"의 두 영역 레이아웃이다(옛 시안 `.lanes`+`.scroll` 구조). 지금 캔버스가
          // 폭을 넘치지 않아도(에픽 수가 적으면 스크롤이 안 생김) 구조를 미리 세워 둔다 — 나중에
          // 노드가 늘어 캔버스가 넓어질 때 이 구조 없이 끼워 넣을 수 없다(구조는 나중에 못 붙인다).
          <div className="flex gap-4">
            <div className="sticky left-0 z-[1] shrink-0 bg-background">
              <FlowLane rows={laneRows} totalEpicCount={data?.totalEpicCount ?? 0} />
            </div>
            <div className="focus-inset min-w-0 flex-1 overflow-x-auto">
              <FlowCanvas rows={laneRows} activeEpicId={activeEpicId} edgeCount={edgeCount} />
            </div>
          </div>
        )}

        {/* ③ 관제 서랍 — 보기 무관 고정, 접힘 기본(IA §2). ExceptionStream = #2100 예외 스트림
            그대로 재사용(A타입, AC4 — glance-board.tsx가 쓰는 그 컴포넌트 그대로, 새로 그린
            코드 없음. 두 컴포넌트가 아니다). `<summary>`는 native하게 접힌 상태에서도 항상
            보이므로 카운트는 접어도 보인다(PO 판정 2026-07-30 — AC8이 접힌 채로도 반쯤 성립).
            ⚠️카운트 출처 — 지금은 `/api/glance/attention`의 gate_pending+blocked+merge_ready
            (WorkflowLineStepApproval/ItemDependency 기반)다. 이것은 민 실측 "검증 필요 32건"
            (Gate.requires_human+evidence_status=insufficient, PR#2672 blocked와 동일 정의로
            맞춤) 과 다른 쿼리라 다른 수를 낼 수 있다 — 그래서 라벨을 "검증 필요"로 부르지 않고
            "게이트·막힘 신호"로 남겨 둔다.
            ⛔만료 조건(PO 2026-07-30, 안 적으면 이 이름이 영구가 된다): PR#2672 착지 시 A로
            통일하고 · 이 자리의 B 라벨을 "검증 필요"로 되돌린다. 그때까지 좌 레인(flow-lane.tsx)
            의 blocked/stalled 칸도 "모름"으로 비워 두고, 막힘류 수는 이 관제 서랍 한 곳에서만
            보인다(같은 화면에 A·B 두 자가 동시에 서지 않게). */}
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-foreground">
            {t('drawerHeading', { n: exceptionItems.length })}
          </summary>
          <div className="border-t border-border p-3">
            <ExceptionStream items={exceptionItems} />
          </div>
        </details>
      </div>
    </>
  );
}
