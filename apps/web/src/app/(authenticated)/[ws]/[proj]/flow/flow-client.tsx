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
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { useIsMobile } from '@/hooks/use-mobile';
import { NextMakerScreen } from '@/components/flow/next-maker-screen';
import { FlowNodeStoryPanel } from '@/components/flow/flow-node-story-panel';
import { HypothesisEarthLayer } from '@/components/flow/hypothesis-earth-layer';
import { HypothesisNarrativePanel } from '@/components/flow/hypothesis-narrative-panel';
import { ScaleLadder } from '@/components/flow/scale-ladder';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';

interface FlowPageClientProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

type FlowView = 'hypothesis' | 'flow' | 'list';

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
// story #2531(E-FLOW-V4 S1, PO 2026-08-08) — v4 조직원리(flow-board-v4-hypothesis-scale
// §2): 축척 최상위(지구 층)는 가설이다. 「본체가 지도로 서는가」 게이트를 «가설이 기본
// 랜딩(?view= 없음)으로 최상위를 차지하는가»로 판정 — 그래서 default가 'flow'(갈래·
// NextMakerScreen)에서 'hypothesis'로 이동한다. 갈래·목록은 폐기 아님 — 나란한 탭으로
// 남아 v3.4 계승(§6)을 만족한다. 가설→갈래 드릴다운은 S5(축척 전환) 몫이라 이번엔 병렬.
//
// story #3043(선생님 실사고·민 실측 2026-08-25, PO+유나 IA 확定 ⓑ) — #2225(모바일 3화면
// 대체 세그)는 실제론 status=backlog·한 줄도 안 짜여 있었다(그라운딩으로 기각) — 그런데도
// 아래 세그를 `isMobile ? null : ...`로 숨겨온 탓에 모바일에서 갈래·목록(칸반) 둘 다 도달
// UI 경로가 0이었다(PO가 "모바일에 보드 없다"고 오답할 정도). 세그를 모바일에서도 그리고
// (아래), 파라미터 없을 때의 모바일 기본값도 flow(갈래 캔버스)에서 list(칸반)로 바꾼다 —
// 「보드가 안 보인다」는 원 신고에 가장 가까운 화면을 첫 진입 기본값으로 세운다. `?view=`가
// URL에 명시돼 있으면 그대로 존중(이 폴백은 파라미터가 아예 없을 때만 개입) — 회귀 없음.
// ⛔카디르 재QA 비차단②(2026-08-09, S3) — 모바일에서 `?hypothesis=<id>`만 있고 `?view=`가
// 없으면(공유 링크·새로고침의 흔한 형태) 위 모바일 기본값(flow)이 이겨 서사 패널이
// 렌더되지 않았다(패널은 view==='hypothesis'에서만 뜬다). hypothesis 파라미터가 있으면
// «명시 view»와 동급으로 존중 — 모바일이어도 그 가설을 보러 온 것이 명백하므로.
// story #3101(Board IA 1단계 B, 유나 규격 doc 85808039 SSOT, PO 확定 2026-08-26) — 데스크톱
// 기본 랜딩도 모바일과 같은 이유로 'hypothesis'→'list'(보드/칸반)로 옮긴다: 탭 이름이 이미
// "보드"인데(app-sidebar.tsx) 첫 착지가 가설 화면이면 명명과 렌더가 어긋난다(§2224/§3043이
// 모바일에서 겪은 것과 같은 클래스, 이번엔 데스크톱). 불변식 「탭 이름=첫 착지 렌더」를 여기서
// 만족시킨다. `?view=`/`?hypothesis=` 명시 파라미터는 그대로 존중(위 3줄 무변경) — 가설·갈래는
// 세그 1클릭으로 여전히 도달 가능(G1, 매핑 고아 0).
function parseView(raw: string | null, hasHypothesisParam: boolean): FlowView {
  if (raw === 'list' || raw === 'kanban') return 'list';
  if (raw === 'flow') return 'flow';
  if (raw === 'hypothesis') return 'hypothesis';
  if (hasHypothesisParam) return 'hypothesis';
  return 'list';
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
  // 유나 지적(2026-07-30) — 모바일은 갈래|칸반 세그를 그리지 않는다(#2225의 갈래·막힘·멈춤
  // 탭이 그 자리를 대신함). CSS로 숨기면 DOM에 둘 다 남아 스크린리더·탭 순서가 겹친다(#2225
  // AC3와 같은 규율) — useIsMobile로 렌더 자체를 가른다. `?view=`는 모바일에서도 URL 정본
  // 그대로라 세그가 없어도 주소로 칸반 진입은 가능하다.
  const isMobile = useIsMobile();
  // story #3101 — 기본값(파라미터 없음)이 이제 데스크톱/모바일 무관 'list' 하나로 고정돼
  // parseView가 isMobile을 더는 받지 않는다(#2531 시절의 기기별 분기 fix는 여기서 소멸 —
  // 애초에 「기본값이 기기마다 다르다」는 전제가 이번 정합으로 사라졌다). hasHypothesisParam은
  // 카디르 재QA 비차단②(S3) — 모바일에서 `?hypothesis=`만 있는 공유링크/새로고침이 패널을
  // 못 열던 것 fix, 이건 그대로 유지.
  const view = parseView(searchParams.get('view'), searchParams.get('hypothesis') !== null);

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

  // story #2545(카디르 라이브 재QA 4단계) — org 불일치 자동교정(switch-org)이 이 fetch *後*
  // 성공하면 projectId는 안 바뀌므로 재요청 트리거가 없었다. 다른 opt-in 컴포넌트들
  // (hypothesis-earth-layer·goals-client·unattached-bucket·flow-multi-lane-canvas)과 동일
  // 패턴 — orgSyncVersion을 트리거 effect 의존성에 얹는다.
  const orgSyncVersion = useOrgSyncVersion();

  useEffect(() => {
    if (!projectId) return;
    const cancelledRef = { cancelled: false };
    fetchData(cancelledRef);
    return () => { cancelledRef.cancelled = true; };
  }, [projectId, fetchData, orgSyncVersion]);

  // story #3101 — 기본값(parseView의 파라미터-없음 폴백)이 'hypothesis'→'list'로
  // 바뀌었으니, "URL을 깨끗이 지워도 되는" 뷰도 같이 옮겨야 한다. 예전 그대로 'hypothesis'
  // 클릭 시 params.delete('view')를 두면 parseView가 그 빈 URL을 'list'로 되돌려 읽어
  // 가설 탭을 눌러도 목록이 뜨는 회귀가 난다(G1 위반 — 가설 화면 증발) — 깨끗한 URL의
  // 자격을 새 기본값(list)로 옮긴다.
  const setView = useCallback((next: FlowView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'list') params.delete('view');
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

  // story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사 패널. story 패널(위)과 달리 「닫아도
  // 선택 유지」 뉘앙스가 AC에 없어 훨씬 단순하게: URL의 `?hypothesis=`가 곧 열림 상태의
  // 단일 소스다(별도 panelOpen 불필요) — 닫으면 파라미터 자체를 지운다.
  const selectedHypothesisId = searchParams.get('hypothesis');
  const handleSelectHypothesis = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('hypothesis', id);
    router.push(`/${wsSlug}/${projSlug}/flow?${params.toString()}`, { scroll: false });
  }, [router, searchParams, wsSlug, projSlug]);
  const handleCloseHypothesisPanel = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('hypothesis');
    const qs = params.toString();
    router.push(`/${wsSlug}/${projSlug}/flow${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [router, searchParams, wsSlug, projSlug]);

  // story #2535(E-FLOW-V4 S5) — 지구→대륙→도시 드릴다운. `?goal=<id>`가 착지점(NextMakerScreen
  // focusGoalId로 흘러가 그 레인만 강제 펼침+스크롤+하이라이트, next-maker-screen.tsx 문서
  // 참고). 가설 패널에서 넘어오는 경로라 `hypothesis` 파라미터는 지우고 view=flow로 간다
  // (지구층에 남아있으면 도시층 레인이 안 보인다).
  const focusGoalId = searchParams.get('goal');
  const handleNavigateToGoal = useCallback((goalId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('hypothesis');
    params.set('view', 'flow');
    params.set('goal', goalId);
    router.push(`/${wsSlug}/${projSlug}/flow?${params.toString()}`, { scroll: false });
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
      {/* story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 재분류(구조·크기 불변):
          TopBar 타이틀=Heading(무게↑만·크기는 TopBar 유지).
          story #2974 §3(PR-D0) — doc이 명시한 소비처: 무게(font-extrabold)는 이미 Heading
          그대로 두고, 페이스(family)만 별도 축으로 font-display 토큰 경유 추가(D0 값=
          var(--font-sans)라 시각 변화 0 — 세리프 켜지면 board TopBar 타이틀도 함께 전환). */}
      <TopBarSlot title={<h1 className="text-sm font-display font-extrabold">{t('title')}</h1>} showContextChip />

      <div className="space-y-4 p-4">
        {/* story #2930(P0-G) I3 — nav에서 flow+sprints가 「보드」 단일 항목으로 접히며 사라진
            sprints 진입점을 메우는 얕은 프레임(WorkspaceFrameTabs). 아래 3탭(가설|갈래|칸반)과
            다른 층 — 그건 안 건드린다(E-FLOW-V4 기 확定). */}
        <WorkspaceFrameTabs active="board" />

        {/* ② 세 칸 세그(가설|갈래|칸반) — story #2531(E-FLOW-V4 S1)에서 「가설」 칸을
            맨 앞에 신설(v4 조직원리 §2, 축척 최상위=가설). 갈래·칸반 두 칸은 07-23
            시안(`e15905e8`)에서 되찾은 것(IA 개정 때 조용히 지워졌던 것, 유나 지적
            2026-07-30) 그대로 — 폐기 아니라 나란한 탭으로 유지(v3.4 계승). ⛔"현황판" 세
            번째 칸은 선생님 재정정으로 지웠었다(그 자리에 이제 "가설"이 대신 선다 — 다른
            이유·다른 칸). story #3043(PO+유나 IA 확定 ⓑ) — 예전엔 모바일에서 이 세그를
            숨기고 #2225(미구현으로 그라운딩 확認) 대체 탭이 그 자리를 대신한다고 가정했으나,
            그 대체물이 실재하지 않아 모바일에 세그도 대체도 둘 다 없는 dead-end였다. 이제
            모바일에서도 그대로 그린다 — 새 모바일 전용 UI를 만들지 않고 데스크톱과 동일
            컴포넌트를 재사용(회귀 위험 최소·유지보수 표면 1개). */}
        <div className="flex items-center gap-1 border-b border-border pb-2">
          <button
            type="button"
            onClick={() => setView('hypothesis')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'hypothesis' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t('viewHypothesis')}
          </button>
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

        {/* story #2535(E-FLOW-V4 S5) — 축척 브레드크럼. 가설 뷰는 HypothesisEarthLayer가
            자기 안에서 이미 사다리를 그리므로(지구=활성) 여기서 중복 안 그린다. 갈래=도시·
            목록=건물 — 「지금 보는 층 = 묻는 질문 전환」을 탭 전환마다 같은 자리에서 보인다. */}
        {view !== 'hypothesis' ? (
          <ScaleLadder activeLevel={view === 'flow' ? 'city' : 'building'} compact={isMobile} />
        ) : null}

        {view === 'hypothesis' ? (
          // story #2531(E-FLOW-V4 S1) — 새 기본 랜딩. 가설(질문)을 최상위 조직 단위로 삼는
          // 지구 층. 드릴다운(가설→갈래)은 S5 몫이라 지금은 독립 탭으로만 존재한다.
          <HypothesisEarthLayer projectId={projectId} onSelectHypothesis={handleSelectHypothesis} />
        ) : view === 'list' ? (
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
              focusGoalId={focusGoalId}
            />
          )
        )}

        {/* story #2354 — 지도 위에 겹치는 패널. list 보기일 땐 KanbanBoard가 이미 자기
            방식(전체화면 드로어)으로 같은 `?story=`를 읽어 여는 중이라(AC9 회귀 없음), 여기서
            또 열면 두 벌이 뜬다 — view==='flow'일 때만 렌더한다.
            ⛔카디르 라이브 QA(2026-08-09, ②MEDIUM) — 조건이 `view !== 'list'`(구 2값
            FlowView 시절 잔재)로 남아있어, story #2531로 view가 3값이 된 뒤 기본(가설) 뷰
            에서도 `/flow?story=<id>`면 패널이 샜다. 주석이 원래 말하던 대로 정확히
            `view === 'flow'`로 좁힌다 — 가설 뷰엔 story 선택 UI 자체가 없어 패널이 뜰
            이유가 없다. */}
        {view === 'flow' && panelOpen && selectedStoryId ? (
          // key={selectedStoryId} — 다른 노드를 연달아 누르면 통째로 다시 마운트시킨다(초기
          // loading 상태가 매번 자연히 맞다, flow-node-story-panel.tsx 문서 참고).
          <FlowNodeStoryPanel key={selectedStoryId} storyId={selectedStoryId} onClose={handleClosePanel} />
        ) : null}

        {/* story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사. 가설 뷰에서만(다른 탭엔 가설 카드
            자체가 없어 selectedHypothesisId가 그 탭에서 생길 일이 없다) */}
        {view === 'hypothesis' && selectedHypothesisId ? (
          <HypothesisNarrativePanel key={selectedHypothesisId} hypothesisId={selectedHypothesisId} onClose={handleCloseHypothesisPanel} onNavigateToGoal={handleNavigateToGoal} />
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
