'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { ExceptionStream } from '@/components/glance/exception-stream';
import { toExceptionQueueItems, type BeAttentionSignal, type ExceptionLabels } from '@/components/glance/derive-exception-signals';
import { loadGlanceData, type GlanceData } from '@/components/glance/load-glance-data';
import { useIsMobile } from '@/hooks/use-mobile';
import { NextMakerScreen } from '@/components/flow/next-maker-screen';
import { FlowNodeStoryPanel } from '@/components/flow/flow-node-story-panel';

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
 * story #2224(IA v2.2 §7-3, 유나 정정 2026-07-30) — 통합 화면. 보기 전환은 두 칸(갈래|목록)
 * 세그이며 `?view=` 쿼리파라미터가 정본(URL이 상태를 들고 있어 새로고침·공유 가능).
 *
 * PO 판정(2026-07-30, 선생님 정정 반영) — "보드+현황판 통합"의 실제 자리는 `/plan`이 아니라
 * `/flow`였다(`/plan`은 말실수). 남은 본체는 `/glance`·`/board`를 이 화면 «안으로» 들이고
 * 옛 라우트를 죽이는 것 하나 — 오늘은 그 1단계(세그먼트 셸)만: 갈래=이 캔버스(그대로) ·
 * 목록=`KanbanBoard`(그대로 마운트, 라벨만 이동).
 *
 * ⛔story #2352(2026-07-31, 유나 적발 → PO 정정) — ②관제 서랍(ExceptionStream)의 원래
 * 결함은 「게이트·막힘 신호 · N」이 0단계 카드의 「승인 대기 · 28」(Gate 표 기반)과 «다른
 * 표»(WorkflowLineStepApproval/ItemDependency 기반 `/api/glance/attention`)를 세면서 같은
 * 낱말("막힘")을 써 화면이 자기모순한 것(28 vs 0)이었다 — 지시는 «그 수»를 이름 없이 빼는
 * 것이었는데 처음엔 «영역 전체»(ExceptionStream)를 걷어내 결함의 목적어가 넓어졌다(#2224
 * AC4가 이 컴포넌트를 하단 관제와 «하나»로 요구하는 것과도 어긋났다). 서랍은 남는다 —
 * 이름만 "막힘"과 안 겹치게 갈고, «수»(N)는 라벨에서 뺀다(영역은 남고 수만 안 보인다).
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

  // ⛔결함 fix(2026-07-31, "다음을 만드는 화면" 착지 — 아티팩트 a920c25f v2) — 예전엔
  // epics-progress-lane을 여기서 따로 fetch해 FlowLane/FlowCanvas에 먹였으나, 그 둘이
  // NextMakerScreen으로 교체되며 그 컴포넌트가 같은 엔드포인트를 자기 몫(막힘 합계)으로
  // 스스로 fetch한다 — 여기서 또 부르면 같은 요청을 두 번 쏘는 것이라 제거한다(§I-6 "두 벌
  // 서지 않는다"의 거울상 — 이번엔 fetch 중복 쪽).
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

  // AC6(판정선) — 패널을 닫아도 URL의 story는 지우지 않는다("누른 노드가 선택된 채로
  // 남는다" — selectedStoryId는 URL이 단일 소스, 열림/닫힘은 이 로컬 boolean만 관여). 다시
  // 그 노드를 누르면 handleSelectStory가 다시 panelOpen=true로 돌린다.
  const [panelOpen, setPanelOpen] = useState(false);
  const selectedStoryId = searchParams.get('story');
  useEffect(() => {
    if (selectedStoryId) setPanelOpen(true);
  }, [selectedStoryId]);
  const handleClosePanel = useCallback(() => setPanelOpen(false), []);

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

  // story #2354 후속(2026-07-31) — 예전엔 view를 'list'로 함께 갈아 끼워 KanbanBoard(그
  // 안의 StoryDetailPanel)를 마운트시켰는데, 그 view 전환 자체가 «갈래 캔버스를
  // 언마운트»시키는 원인이었다(선생님 "인터랙션이 없다"의 구조적 뿌리 — 조사 결론:
  // 옛 flow-client.tsx:111 주석 "view를 list로 함께 바꿔야 KanbanBoard 자체가 마운트된다").
  // 이제 `?story=`만 붙이고 view는 손대지 않는다 — 캔버스는 그대로 살아있고, 아래
  // `FlowNodeStoryPanel`이 지도 위에 겹쳐 뜬다.
  const handleSelectStory = useCallback((storyId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('story', storyId);
    router.push(`/${wsSlug}/${projSlug}/flow?${params.toString()}`, { scroll: false });
    setPanelOpen(true);
  }, [router, searchParams, wsSlug, projSlug]);

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
          // 「갈래」보기 — story #2224 AC1(2026-07-31) 멀티레인 본체. 30일 안 변화 있는 목표
          // «전부»를 레인으로 동시에 그린다(목표 하나를 고르던 이전 판을 대체 — 그 판이
          // AC17-B가 잡은 「지도가 18.7%로 눌림」의 원인이었다, next-maker-screen.tsx 문서
          // 참고). PO 정정(같은 날 오후) — 그 판이 실어 나르던 승격/전환 «동사»는 되살려
          // NextActionsStrip으로 옮겼고, memberMap은 그 안(GoalStemCard의 담당자 이름 표시)의
          // 재료라 그대로 살아 있다.
          loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t('loading')}
            </div>
          ) : (
            <NextMakerScreen
              projectId={projectId}
              memberMap={data?.memberMap ?? {}}
              onSelectStory={handleSelectStory}
              selectedNodeId={selectedStoryId}
            />
          )
        )}

        {/* story #2354 — 지도 위에 겹치는 패널. list 보기일 땐 KanbanBoard가 이미 자기
            방식(전체화면 드로어)으로 같은 `?story=`를 읽어 여는 중이라(AC9 회귀 없음), 여기서
            또 열면 두 벌이 뜬다 — view==='flow'일 때만 렌더한다. */}
        {view !== 'list' && panelOpen && selectedStoryId ? (
          // key={selectedStoryId} — 다른 노드를 연달아 누르면 통째로 다시 마운트시킨다(초기
          // loading 상태가 매번 자연히 맞다, flow-node-story-panel.tsx 문서 참고).
          <FlowNodeStoryPanel key={selectedStoryId} storyId={selectedStoryId} onClose={handleClosePanel} />
        ) : null}

        {/* ③ 관제 서랍 — 보기 무관 고정, 접힘 기본(IA §2). ExceptionStream = #2100 예외 스트림
            그대로 재사용(A타입, AC4 — #2224 AC4가 이 컴포넌트와 하단 관제를 "하나"로 요구).
            ⛔story #2352(PO 정정) — 라벨을 "게이트·막힘 신호 · N"에서 갈았다. 그 N은
            0단계 카드의 「승인 대기 · 28」(Gate 표)과 다른 표(WorkflowLineStepApproval/
            ItemDependency 기반)를 세면서 같은 낱말("막힘")로 화면이 자기모순했다(28 vs 0) —
            지시는 «그 수»를 이름 없이 빼는 것이었다(영역은 남긴다). 새 라벨은 숫자 없이
            "승인 흐름에서 멈춘 것"만 말한다 — 두 「막힘」이 더는 안 겹친다. */}
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-foreground">
            {t('drawerHeadingNoCount')}
          </summary>
          <div className="border-t border-border p-3">
            <ExceptionStream items={exceptionItems} />
          </div>
        </details>
      </div>
    </>
  );
}
