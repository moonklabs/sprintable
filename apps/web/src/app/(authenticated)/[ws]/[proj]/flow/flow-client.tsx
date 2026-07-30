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
import { deriveFlowLaneRows, type EpicsProgressLaneResponse } from '@/components/flow/derive-flow';

interface FlowPageClientProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

type FlowView = 'flow' | 'list';

// PO 판정(2026-07-30) — 선생님 원 지시("보드+현황판 통합, `/plan`은 말실수·`/flow`가 그
// 자리")에 따라 07-23 시안(`e15905e8`)의 「갈래|목록」 세그를 되찾는다(IA 개정 때 조용히
// 지워졌던 것 — 유나 지적). `kanban`은 지난 배포분(PR#2691/#2694) 링크가 이미 떠 있을 수 있어
// `list`의 레거시 별칭으로 계속 받는다(URL 하위호환 — 링크가 조용히 깨지지 않는다).
//
// ⛔선생님 재정정(2026-07-30, PR#2696 CI 중에 도착 — 머지 前에 반영) — "현황판" 3번째 칸은
// 지웠다(짓지 않은 게 아니라 "안 짓기로" 확定해 없앤 것). 근거: glance의 다섯 소스가 전부
// 다른 자리로 흡수된다 — goals+focal→좌 레인+①초점 스트립, dashboard/overview 총계→관제
// 범례 statusbar, glance/attention 예외→③관제, team-members 협업맵 재료→③관제의 원인
// 하나로, 진행 궤적→시간축이 대체(따로 안 옮김). activity-logs만 목업 자체가 자리를
// 정하지 않은 유일한 칸이라 판정 대기. 즉 현황판은 "갈래 캔버스가 더 잘 하는 것의 열등한
// 판"이라 보기로도 남지 않는다.
function parseView(raw: string | null): FlowView {
  if (raw === 'list' || raw === 'kanban') return 'list';
  return 'flow';
}

/**
 * story #2224(IA v2.2 §7-3, 유나 정정 2026-07-30) — 통합 화면. ①초점 스트립(GlanceHero, A타입
 * 재사용) ②관제 서랍(ExceptionStream, A타입 재사용) 은 보기와 무관하게 항상 고정 — "전면에서
 * 내린다"는 뜻이 이것이다(보기를 전환해도 이 둘은 그대로 남는다). 보기 전환은 두 칸(갈래|목록)
 * 세그이며 `?view=` 쿼리파라미터가 정본(URL이 상태를 들고 있어 새로고침·공유 가능).
 *
 * PO 판정(2026-07-30, 선생님 정정 반영) — "보드+현황판 통합"의 실제 자리는 `/plan`이 아니라
 * `/flow`였다(`/plan`은 말실수). 남은 본체는 `/glance`·`/board`를 이 화면 «안으로» 들이고
 * 옛 라우트를 죽이는 것 하나 — 오늘은 그 1단계(세그먼트 셸)만: 갈래=이 캔버스(그대로) ·
 * 목록=`KanbanBoard`(그대로 마운트, 라벨만 이동). glance의 다섯 소스는 「현황판」이라는 별도
 * 보기가 아니라 갈래 보기·관제 서랍의 기존 영역에 나눠 얹는다(선생님 재정정 — 진행 궤적은
 * 시간축이 대체해 따로 옮기지 않고, `activity-logs`만 목업 자체가 자리를 정하지 않은 유일한
 * 칸이라 판정 대기) — 이 나눠얹기 자체는 후속 조각.
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
  // L2 정정(유나 목업 eacf5b50, 2026-07-30) — 좌 레인 5분류(#2672)+시간축 3분류(#2686)의
  // 단일 소스. loadGlanceData()와 별도 fetch인 이유: 그 함수는 /glance와 공유하는지라(§I-6
  // "두 벌 서지 않는다") 건드리지 않는다 — 이 화면(/flow)만 쓰는 재료라 여기서 따로 부른다.
  // 실패해도 laneRows는 hasLaneData=false로 정직하게 비고, 화면이 죽지 않는다(null 유지).
  const [laneData, setLaneData] = useState<EpicsProgressLaneResponse | null>(null);

  const fetchData = useCallback((cancelledRef: { cancelled: boolean }) => {
    setLoading(true);
    void (async () => {
      try {
        const [result, laneResult] = await Promise.all([
          loadGlanceData(projectId),
          fetch(`/api/analytics/epics-progress-lane?project_id=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((json: { data?: EpicsProgressLaneResponse } | null) => json?.data ?? null)
            .catch(() => null),
        ]);
        if (cancelledRef.cancelled) return;
        setData(result);
        setLaneData(laneResult);
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

  const laneRows = useMemo(() => deriveFlowLaneRows(data?.roadmap ?? [], laneData), [data, laneData]);
  const activeEpicId = useMemo(() => data?.roadmap.find((e) => e.roadmapStatus === 'active')?.id ?? null, [data]);

  // #2221(구조화된 연결 간선) 미착지 — 실제 배열 길이 0에서 나온 값이지 리터럴이 아니다.
  // #2221이 착지해 실 간선 배열을 내려주면 이 상수를 그 배열의 length로 바꾸는 것으로 끝난다.
  const edgeCount = 0;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />

      <div className="space-y-4 p-4">
        {/* ② 두 칸 세그(갈래|칸반) — 07-23 시안(`e15905e8`)에서 되찾음(IA 개정 때 조용히
            지워졌던 것, 유나 지적 2026-07-30). ⛔"현황판" 세 번째 칸은 선생님 재정정으로
            지웠다(짓지 않은 게 아니라 "안 짓기로" 확定해 없앤 것 — glance의 다섯 소스가 전부
            다른 자리로 흡수되어 열등한 세 번째 판이 필요 없어졌다). 모바일은 #2225의
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
              onClick={() => setView('list')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t('viewList')}
            </button>
          </div>
        )}

        {view === 'list' ? (
          // 2026-07-30 PO 확認 대기 — 07-23 시안의 「목록」이 칸반과 동일한지 디디군이 확認
          // 중(단순 표라면 드래그로 상태를 바꾸는 길이 사라지는지라 다르다). 답 오기 前엔
          // 되돌리기 쉬운 쪽(칸반 그대로 임베드)으로 가정한다 — kanban-board.tsx를 새로 그리지
          // 않고 그대로 마운트, `?view=kanban`(레거시)도 이 칸으로 들어온다.
          <KanbanBoard projectId={projectId} wsSlug={wsSlug} projSlug={projSlug} />
        ) : (
          // 「갈래」보기 — 목업(`63b240a4`) 세 영역 중 ①초점 스트립+②L3 캔버스가 이 보기의
          // 규격이다(③관제만 보기 밖 껍데기로 승격, 구조 최종 확定 2026-07-30 — 유나양이 "목업
          // 세 영역=갈래 보기의 규격"으로 층을 갈라 세그 구조와의 충돌을 풀었다).
          <>
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

            {/* IA §2 유나 추가 지적(2026-07-30) — 좌 레인은 "블록 하나"가 아니라 "고정 열 + 가로
                스크롤 캔버스"의 두 영역 레이아웃이다(옛 시안 `.lanes`+`.scroll` 구조). 지금 캔버스가
                폭을 넘치지 않아도(에픽 수가 적으면 스크롤이 안 생김) 구조를 미리 세워 둔다 — 나중에
                노드가 늘어 캔버스가 넓어질 때 이 구조 없이 끼워 넣을 수 없다(구조는 나중에 못 붙인다). */}
            <div className="flex gap-4">
              {/* 레인은 캔버스의 «형제»라 스크롤 조상이 아니다 — sticky 불요(옛 시안
                  `.lanes{position:relative}`와 동일 패턴). 전에 `sticky left-0`을 달았었는데
                  그건 트리거할 스크롤 조상이 없어 실제로는 아무것도 안 하는 코드였다(PO 지적
                  2026-07-30 — "무해하나 무의미한 선언은 무해하지 않다", 다음 사람이 "이게 sticky로
                  도는구나"로 오독한다). ⛔구조를 부모-자식(레인이 캔버스 안으로 들어가는 형태)으로
                  바꾸면 그때 sticky가 다시 필요해진다 — 그때 재검토. */}
              <div className="shrink-0 bg-background">
                <FlowLane rows={laneRows} totalEpicCount={data?.totalEpicCount ?? 0} />
              </div>
              <div className="focus-inset min-w-0 flex-1 overflow-x-auto">
                <FlowCanvas rows={laneRows} activeEpicId={activeEpicId} edgeCount={edgeCount} projectId={projectId} />
              </div>
            </div>
          </>
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
