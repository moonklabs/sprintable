'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  parseGoals, parseStories, parseNextUp, filterActiveGoals,
  deriveGoalStems, deriveRecentlyClosedEpicIds, sortStemsByStallUrgency,
  deriveHeadline, deriveZeroStageStats, deriveOrphanStories, deriveActiveLaneGoals,
  type NextMakerGoal, type NextMakerStory, type RawGoal, type RawStoryLite, type RawNextUp,
  type GoalStem,
} from './derive-next-maker';
import { NextMakerHeader } from './next-maker-header';
import type { MemberLite } from './goal-stem-card';
import { NextActionsStrip } from './next-actions-strip';
import { OrphanStoriesPanel } from './orphan-stories-panel';
import { FlowMultiLaneCanvas } from './flow-multi-lane-canvas';
import { parseCursorMeta } from '@/lib/pagination';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/db/client';

interface NextMakerScreenProps {
  projectId: string;
  memberMap: Record<string, MemberLite>;
  onSelectStory: (storyId: string) => void;
  /** story #2354 — 순수 통과 prop(FlowMapCanvas 참고, 노드 선택 고리 강조). */
  selectedNodeId?: string | null;
  /** story #2535(E-FLOW-V4 S5) — 지구(가설)→대륙(목표)→도시(갈래) 드릴다운의 착지점.
   * 이 목표가 30일 무변화로 접힘 대상이었어도 강제로 펼침(카드 폭발 회피를 «구조»로 —
   * 다른 레인은 안 건드리고 이 레인 «하나»만 예외로 편다) + 그 레인으로 스크롤+하이라이트. */
  focusGoalId?: string | null;
}

interface Envelope<T> { data: T; meta?: unknown }

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

// 활성(non-done) 상태만 — done은 이 화면의 계산에 안 쓰인다("과거는 한 카드"·PO note ⑥,
// 여기선 카드조차 없이 아예 fetch하지 않는다. done 스토리 수는 이미 goals의
// total_stories/done_stories로 충분하다).
const ACTIVE_STATUSES = ['backlog', 'ready-for-dev', 'in-progress', 'in-review'] as const;
const PAGE_LIMIT = 100; // /api/goals, /api/stories FE 프록시 상한(parseCursorPageInput maxLimit).
const SAFETY_MAX_PAGES = 50; // 무한루프 방어 — 100*50=5000건, 오늘 이 project 규모를 넉넉히 상회.

async function fetchAllPages<T>(urlBuilder: (cursor: string | null) => string, source: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SAFETY_MAX_PAGES; page += 1) {
    const res = await fetch(urlBuilder(cursor));
    if (!res.ok) break;
    const json: Envelope<T[]> = await res.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    items.push(...rows);
    const cursorMeta = parseCursorMeta(json.meta, source);
    if (!cursorMeta.hasMore || !cursorMeta.nextCursor) break;
    cursor = cursorMeta.nextCursor;
  }
  return items;
}

async function fetchAllGoals(projectId: string): Promise<RawGoal[]> {
  return fetchAllPages<RawGoal>(
    (cursor) => `/api/goals?project_id=${projectId}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    'NextMakerScreen.fetchAllGoals',
  );
}

async function fetchAllStoriesByStatus(projectId: string, status: string): Promise<RawStoryLite[]> {
  return fetchAllPages<RawStoryLite>(
    (cursor) => `/api/stories?project_id=${projectId}&status=${status}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    `NextMakerScreen.fetchAllStoriesByStatus(${status})`,
  );
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; goals: NextMakerGoal[]; activeStories: NextMakerStory[]; recentlyClosedEpicIds: Set<string>; recentlyClosedTargetIds: Set<string>; blockedCount: number };

/**
 * story #2224 AC1(2026-07-31, 목업 84abdf43 v5 "팀의 흐름이 한눈에") — 갈래 캔버스의 몸통을
 * «목표 하나를 골라 보는 것»에서 «팀의 흐름을 한 번에 보는 것」으로 다시 짰다.
 *
 * ⛔선대(2026-07-31 오전) 판과의 차이 — 그 판은 왼쪽 좁은 열에서 줄기 하나를 고르면
 * 오른쪽에 «그 목표만»의 픽 패널+캔버스가 섰다(머리:갈래=1:3). 그 구조가 AC17-B가 잡은
 * 결함의 원인이었다(픽 패널+줄기 목록이 캔버스 위 66%를 먹었다) — 그래서 「목표 하나를
 * 고르는」 «단일-포커스»는 뺐다. 단, PO가 되돌린 것 — 그 패널이 실어 나르던 «동사 둘»
 * (백로그 스토리 승격 / 조용한 목표 닫기·보관)은 «수단»(픽 패널)이 아니라 «목적»이라 같이
 * 죽으면 안 된다(PO: 「«수단»을 빼면 그 위에 탄 «다른 목적»이 같이 죽는다」). 그래서
 * `NextActionsStrip`(다음이 없는 목표만, 접힌 채 기본·펼치면 그 목표의 승격/전환 패널만)을
 * 다시 세웠다 — 캔버스(FlowMultiLaneCanvas)는 여전히 이 화면의 몸통이고, 이 스트립은 그
 * «아래»에 얹히는 자리다(고아 배정은 원래도 안 지웠다).
 *
 * ⛔AC17-B 재정정(2026-07-31, 선생님 직접 지적) — 처음엔 헤드라인+스트립을 캔버스 «위»에
 * 두고 "지도가 가장 높은 블록"이면 된다고 판단했는데, 그건 «높이» 판정이지 «자리» 판정이
 * 아니었다. 선생님: "지도가 페이지 상단에 붙어야 맞을 것 같고, 나머지는 지도 하단에
 * 붙어야 하지 않을지" — 순서 자체를 뒤집었다. 캔버스가 이 화면의 맨 위, 헤드라인+스트립+
 * 고아 패널은 전부 그 아래.
 *
 * 새 BE 계약 불요(next-up(PR#2707)·goals(total_stories/done_stories 기존 존재)·stories
 * (status 필터 기존 존재)만으로 충분함을 그라운딩 확認했다).
 *
 * ⛔done 스토리는 이 화면에서 fetch하지 않는다(goals.total_stories/done_stories로 충분).
 */
export function NextMakerScreen({ projectId, memberMap, onSelectStory, selectedNodeId = null, focusGoalId = null }: NextMakerScreenProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org) 성공 直後 이
  // 로드 effect도 재요청되게 orgSyncVersion을 의존성에 얹는다(다른 opt-in 컴포넌트와 동일).
  const orgSyncVersion = useOrgSyncVersion();
  // 스토리 하나가 승격(backlog→ready-for-dev)되거나 목표가 전이(done/archived)되면, 전체
  // 재fetch 없이 로컬 상태만 갱신한다(PO 왕복 완료 조건 — 승격이 «즉시» 화면에 반영돼야
  // "실제로 다음이 생겼다"가 눈으로 보인다).
  const [promotedIds, setPromotedIds] = useState<Set<string>>(new Set());
  const [transitionedEpicIds, setTransitionedEpicIds] = useState<Set<string>>(new Set());
  const { toasts, addToast, dismissToast } = useToast();
  // 「목표 정하기」(PO 판정 2026-07-31) — 배정된 스토리는 로컬에서 즉시 그 목표 소속으로
  // 반영한다. 재fetch 없이도 그 목표의 레인이 즉시 그 스토리를 받고 orphan 목록에서 즉시
  // 빠진다 — "안 보이면 잃는다"의 반대(배정하면 즉시 눈에 보이는 것).
  const [assignedEpicByStoryId, setAssignedEpicByStoryId] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rawGoals, storiesByStatus, nextUpRes, laneRes] = await Promise.all([
          fetchAllGoals(projectId),
          Promise.all(ACTIVE_STATUSES.map((status) => fetchAllStoriesByStatus(projectId, status))),
          fetchWithAuth(`/api/reference-candidates/next-up?project_id=${projectId}&recent_days=14`)
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []),
          fetchWithAuth(`/api/analytics/epics-progress-lane?project_id=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (cancelled) return;

        const goals = filterActiveGoals(parseGoals(rawGoals));
        const activeStories = parseStories(storiesByStatus.flat());
        const rawNextUp: RawNextUp[] = Array.isArray(nextUpRes) ? nextUpRes : [];
        const nextUp = parseNextUp(rawNextUp);
        const recentlyClosedEpicIds = deriveRecentlyClosedEpicIds(nextUp, activeStories);
        const recentlyClosedTargetIds = new Set(nextUp.filter((r) => r.isRecent).map((r) => r.targetId));

        const laneData = unwrap<{ epics: Record<string, { blocked: number }> }>(laneRes);
        const blockedCount = laneData
          ? Object.values(laneData.epics).reduce((sum, e) => sum + (e.blocked ?? 0), 0)
          : 0;

        setState({ kind: 'ready', goals, activeStories, recentlyClosedEpicIds, recentlyClosedTargetIds, blockedCount });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, orgSyncVersion]);

  // 까심 QA REQUEST_CHANGES(2026-07-31) 후속 — 「다음으로」는 backlog→ready-for-dev로 상태를
  // 바꾸는 동작이라 되돌릴 길이 없으면 누르기가 무서워진다. 되돌리기 자체도 진짜 서버 PATCH이지
  // 로컬 상태만 뒤집는 낙관적 되돌림이 아니다(원래 승격도 서버 200 후에만 반영했던 것과 동형).
  const handleUndoPromote = useCallback((storyId: string) => {
    fetch(`/api/stories/${storyId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'backlog' }),
    })
      .then((r) => {
        if (r.ok) {
          setPromotedIds((prev) => {
            const next = new Set(prev);
            next.delete(storyId);
            return next;
          });
        } else {
          addToast({ title: t('nextMakerUndoFailedToast'), type: 'error' });
        }
      })
      .catch(() => addToast({ title: t('nextMakerUndoFailedToast'), type: 'error' }));
  }, [addToast, t]);
  const handleStoryPromoted = useCallback((storyId: string) => {
    setPromotedIds((prev) => new Set(prev).add(storyId));
    // 오르테가 PO 판정(2026-07-31) — 「다음으로」는 되돌릴 일이 드문 동작이라 상시 되돌리기
    // 버튼(행마다)은 화면을 무겁게 한다고 판단, undo 토스트(몇 초짜리 창) 쪽으로 간다.
    addToast({
      title: t('nextMakerPromoteSuccessToast'),
      type: 'success',
      action: { label: t('nextMakerUndoAction'), onClick: () => handleUndoPromote(storyId) },
    });
  }, [addToast, handleUndoPromote, t]);
  const handlePromoteFailed = useCallback(() => {
    addToast({ title: t('nextMakerPromoteFailedToast'), type: 'error' });
  }, [addToast, t]);
  const handleGoalTransitioned = useCallback((epicId: string) => {
    setTransitionedEpicIds((prev) => new Set(prev).add(epicId));
  }, []);
  const handleOrphanAssigned = useCallback((storyId: string, epicId: string) => {
    setAssignedEpicByStoryId((prev) => new Map(prev).set(storyId, epicId));
  }, []);

  // 승격된 스토리는 로컬에서 즉시 ready-for-dev로 반영, 배정된 스토리는 즉시 그 목표
  // 소속으로 반영(재fetch 없이) — 왕복이 화면에 바로 보이는 것이 완료 조건(PO)이라 서버
  // 재조회를 기다리게 하지 않는다.
  const effectiveActiveStories = useMemo(() => {
    if (state.kind !== 'ready') return [];
    if (promotedIds.size === 0 && assignedEpicByStoryId.size === 0) return state.activeStories;
    return state.activeStories.map((s) => {
      const patched = { ...s };
      if (promotedIds.has(s.id)) patched.status = 'ready-for-dev';
      const newEpicId = assignedEpicByStoryId.get(s.id);
      if (newEpicId) patched.epicId = newEpicId;
      return patched;
    });
  }, [state, promotedIds, assignedEpicByStoryId]);

  const effectiveGoals = useMemo(() => {
    if (state.kind !== 'ready') return [];
    if (transitionedEpicIds.size === 0) return state.goals;
    return state.goals.filter((g) => !transitionedEpicIds.has(g.id));
  }, [state, transitionedEpicIds]);

  const stems: GoalStem[] = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return deriveGoalStems(effectiveGoals, effectiveActiveStories, state.recentlyClosedEpicIds);
  }, [state, effectiveGoals, effectiveActiveStories]);

  const headline = useMemo(() => deriveHeadline(stems), [stems]);
  const zeroStage = useMemo(
    () => (state.kind === 'ready' ? deriveZeroStageStats(effectiveActiveStories, state.blockedCount) : null),
    [state, effectiveActiveStories],
  );

  const backlogByEpic = useMemo(() => {
    const map = new Map<string, NextMakerStory[]>();
    for (const s of effectiveActiveStories) {
      if (s.status !== 'backlog' || !s.epicId) continue;
      const list = map.get(s.epicId);
      if (list) list.push(s);
      else map.set(s.epicId, [s]);
    }
    return map;
  }, [effectiveActiveStories]);

  const needsNextStems = useMemo(() => sortStemsByStallUrgency(stems.filter((s) => !s.hasNext)), [stems]);
  const orphanStories = useMemo(() => deriveOrphanStories(effectiveActiveStories), [effectiveActiveStories]);

  // react-hooks/purity — Date.now()는 렌더(useMemo 포함) 밖에서 한 번만 잰다(마운트 시점의
  // "지금"이면 충분하다, 30일 창이라 초 단위 정밀도가 안 중요하다). 매 렌더 다시 재면 순수성
  // 규칙 위반이자 laneGrouping이 불필요하게 매번 다른 참조가 될 위험도 있다.
  const [nowMs] = useState(() => Date.now());

  // story #2224 AC1 — 스토리가 «정말 0건»인 목표는 레인 자체를 안 그린다(PO 정정: 접힘과
  // 0건은 다른 사정이라 섞으면 뜻이 흐려진다). 나머지만 30일-변화 성질로 펼침/접힘을 가른다.
  //
  // story #2535(E-FLOW-V4 S5) — focusGoalId가 30일 무변화로 fold 쪽에 떨어졌으면 그 목표
  // «하나»만 강제로 expand로 옮긴다(다른 레인은 그대로 접힌 채 — 카드 폭발 회피를 구조로
  // 지킨다). 지구→대륙→도시 드릴다운으로 왔는데 목표가 안 보이면 다리가 끊긴 것이다.
  const laneGrouping = useMemo(() => {
    if (state.kind !== 'ready') return { expand: [], fold: [] };
    const goalsWithStories = effectiveGoals.filter((g) => g.totalStories > 0);
    const base = deriveActiveLaneGoals(goalsWithStories, effectiveActiveStories, nowMs);
    if (!focusGoalId || base.expand.some((g) => g.id === focusGoalId)) return base;
    const foldedTarget = base.fold.find((g) => g.id === focusGoalId);
    if (!foldedTarget) return base;
    return {
      expand: [...base.expand, foldedTarget],
      fold: base.fold.filter((g) => g.id !== focusGoalId),
    };
  }, [state, effectiveGoals, effectiveActiveStories, nowMs, focusGoalId]);

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('nextMakerLoading')}
      </div>
    );
  }
  if (state.kind === 'error' || !zeroStage) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t('nextMakerError')}</p>;
  }

  return (
    <div className="space-y-4">
      {/* story #2224 AC17-B 재정정(2026-07-31, 선생님 직접 지적) — AC17-B를 "지도가 첫
          화면에서 가장 높은 블록"(높이 비교)으로만 쟀는데, 그건 «높이»를 줄이는 처방(스트립을
          접는 것)에는 걸리되 «자리»(어디에 있는가) 문제는 안 풀었다. 지도가 맨 위, 나머지
          (헤드라인·수 카드·다음-비어있음/조용함 목록)는 전부 그 아래로 — 순서 자체를
          뒤집는다. 지도 pane 높이를 사용자가 조절하는 것(유나 소견 대기 — 기본 높이·저장
          자리)은 후속 조각. */}
      <FlowMultiLaneCanvas
        projectId={projectId}
        expandGoals={laneGrouping.expand}
        foldedCount={laneGrouping.fold.length}
        onSelectStory={onSelectStory}
        selectedNodeId={selectedNodeId}
        memberMap={memberMap}
        focusGoalId={focusGoalId}
      />

      <NextMakerHeader headline={headline} zeroStage={zeroStage} />

      {/* PO 정정(2026-07-31) — 픽 패널의 «고르기»는 뺐지만 승격/전환 «동사»는 살린다. 이
          스트립이 목표 수만큼 길어질 수 있다는 것(AC17-B 재발의 원인이었다 — next-maker-
          screen.tsx 상단 문서 참고)은 그대로다 — 다만 이제 캔버스가 «맨 위»라 이 스트립이
          아무리 길어도 첫 화면(캔버스)을 밀어내지 않는다. 접기(그룹 요약 한 줄)는 시도했다가
          물렀다(PO: "지도가 위에 있으면 아래가 길어도 첫 화면은 안 밀린다") — 자리 문제를
          자리로 풀었으니 높이를 줄이는 처방은 이제 안 필요하다. */}
      <NextActionsStrip
        needsNextStems={needsNextStems}
        quietCount={headline.quietCount}
        projectId={projectId}
        backlogByEpic={backlogByEpic}
        recentlyClosedTargetIds={state.kind === 'ready' ? state.recentlyClosedTargetIds : new Set()}
        memberMap={memberMap}
        onSelectStory={onSelectStory}
        onStoryPromoted={handleStoryPromoted}
        onPromoteFailed={handlePromoteFailed}
        onGoalTransitioned={handleGoalTransitioned}
      />

      {/* 목표가 «없는» 스토리 — 목표별 레인 캔버스 다음 순서(자리는 «남는 곳»이 아니라
          «성질»로 정한다는 기존 판정 그대로, 이 화면의 몸통이 캔버스로 바뀌어도 유효). */}
      <OrphanStoriesPanel
        orphanStories={orphanStories}
        activeGoals={effectiveGoals}
        onSelectStory={onSelectStory}
        onAssigned={handleOrphanAssigned}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
