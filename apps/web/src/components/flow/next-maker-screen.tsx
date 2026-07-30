'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  parseGoals, parseStories, parseNextUp, filterActiveGoals,
  deriveGoalStems, deriveRecentlyClosedEpicIds, sortStemsByStallUrgency,
  deriveHeadline, deriveZeroStageStats, deriveOrphanStories,
  type NextMakerGoal, type NextMakerStory, type RawGoal, type RawStoryLite, type RawNextUp,
  type GoalStem,
} from './derive-next-maker';
import { NextMakerHeader } from './next-maker-header';
import { GoalStemCard, type MemberLite } from './goal-stem-card';
import { OrphanStoriesPanel } from './orphan-stories-panel';
import { parseCursorMeta } from '@/lib/pagination';

interface NextMakerScreenProps {
  projectId: string;
  memberMap: Record<string, MemberLite>;
  onSelectStory: (storyId: string) => void;
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
 * story #2224 후속(2026-07-31, PO 지시 — 아티팩트 a920c25f v2 "갈래 — 다음을 만드는 화면").
 * 기존 GlanceHero+FlowLane+FlowCanvas(에픽 아코디언 목록)를 대체한다 — flow-client.tsx가 이
 * 컴포넌트를 그 자리에 끼운다. 새 BE 계약 불요(PO 지시대로 "있는 것으로 되는지 먼저 재고"
 * 결과 next-up(PR#2707)·goals(total_stories/done_stories 기존 존재)·stories(status 필터
 * 기존 존재)만으로 충분함을 그라운딩 확認했다 — next-up FE 프록시(`/api/reference-candidates/
 * next-up`)만 신설(BE 계약은 그대로, 통과 라우트만 없었다).
 *
 * ⛔done 스토리는 이 화면에서 fetch하지 않는다(goals.total_stories/done_stories로 충분 —
 * "과거는 한 카드"조차 필요 없이 계산에서 아예 제외). 5개 상태 중 4개(backlog·ready-for-dev·
 * in-progress·in-review)만 프로젝트 전체로 긁는다 — 실측(아티팩트 리드) "미래는 39개"라
 * project 규모 전체를 긁어도 가볍다.
 */
export function NextMakerScreen({ projectId, memberMap, onSelectStory }: NextMakerScreenProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // 스토리 하나가 승격(backlog→ready-for-dev)되거나 목표가 전이(done/archived)되면, 전체
  // 재fetch 없이 로컬 상태만 갱신한다(PO 왕복 완료 조건 — 승격이 «즉시» 화면에 반영돼야
  // "실제로 다음이 생겼다"가 눈으로 보인다). refetchNonce로 강제 전체 재계산은 별도 트리거.
  const [promotedIds, setPromotedIds] = useState<Set<string>>(new Set());
  const [transitionedEpicIds, setTransitionedEpicIds] = useState<Set<string>>(new Set());
  // 「목표 정하기」(PO 판정 2026-07-31) — 배정된 스토리는 로컬에서 즉시 그 목표 소속으로
  // 반영한다(promotedIds와 같은 패턴). 재fetch 없이도 그 목표의 대기 칸이 즉시 늘고 orphan
  // 목록에서 즉시 빠진다 — "안 보이면 잃는다"의 반대(배정하면 즉시 줄기에 서는 것이 보인다).
  const [assignedEpicByStoryId, setAssignedEpicByStoryId] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rawGoals, storiesByStatus, nextUpRes, laneRes] = await Promise.all([
          fetchAllGoals(projectId),
          Promise.all(ACTIVE_STATUSES.map((status) => fetchAllStoriesByStatus(projectId, status))),
          fetch(`/api/reference-candidates/next-up?project_id=${projectId}&recent_days=14`)
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => []),
          fetch(`/api/analytics/epics-progress-lane?project_id=${projectId}`)
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
  }, [projectId]);

  const handleStoryPromoted = useCallback((storyId: string) => {
    setPromotedIds((prev) => new Set(prev).add(storyId));
  }, []);
  const handleGoalTransitioned = useCallback((epicId: string) => {
    setTransitionedEpicIds((prev) => new Set(prev).add(epicId));
  }, []);
  const handleOrphanAssigned = useCallback((storyId: string, epicId: string) => {
    setAssignedEpicByStoryId((prev) => new Map(prev).set(storyId, epicId));
  }, []);

  // 승격된 스토리는 로컬에서 즉시 ready-for-dev로 승격 반영, 배정된 스토리는 즉시 그
  // 목표 소속으로 반영(재fetch 없이) — 왕복이 화면에 바로 보이는 것이 완료 조건(PO)이라
  // 서버 재조회를 기다리게 하지 않는다.
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
  const hasNextStems = useMemo(() => stems.filter((s) => s.hasNext), [stems]);
  const orphanStories = useMemo(() => deriveOrphanStories(effectiveActiveStories), [effectiveActiveStories]);

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
      <NextMakerHeader headline={headline} zeroStage={zeroStage} />

      {/* PO 판정(2026-07-31) — 첫 줄 «아래» 별도 줄(다른 축, 섞지 않는다). 줄기가 없는
          것은 「다음 고르기」 목록에 영영 안 뜬다(줄기별 구조라서) — 별도 패널로 세운다. */}
      <OrphanStoriesPanel
        orphanStories={orphanStories}
        activeGoals={effectiveGoals}
        onSelectStory={onSelectStory}
        onAssigned={handleOrphanAssigned}
      />

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {t('nextMakerNeedsNextHeading', { n: headline.needsNextCount })}
        </p>
        {needsNextStems.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('nextMakerAllHaveNext')}</p>
        ) : (
          needsNextStems.map((stem) => (
            <GoalStemCard
              key={stem.epicId}
              stem={stem}
              projectId={projectId}
              backlogStories={backlogByEpic.get(stem.epicId) ?? []}
              recentlyClosedTargetIds={state.kind === 'ready' ? state.recentlyClosedTargetIds : new Set()}
              memberMap={memberMap}
              onSelectStory={onSelectStory}
              onStoryPromoted={handleStoryPromoted}
              onGoalTransitioned={handleGoalTransitioned}
            />
          ))
        )}
      </div>

      {hasNextStems.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t('nextMakerHasNextHeading', { n: headline.hasNextCount })}
          </p>
          {hasNextStems.map((stem) => (
            <GoalStemCard
              key={stem.epicId}
              stem={stem}
              projectId={projectId}
              backlogStories={backlogByEpic.get(stem.epicId) ?? []}
              recentlyClosedTargetIds={state.kind === 'ready' ? state.recentlyClosedTargetIds : new Set()}
              memberMap={memberMap}
              onSelectStory={onSelectStory}
              onStoryPromoted={handleStoryPromoted}
              onGoalTransitioned={handleGoalTransitioned}
            />
          ))}
        </div>
      )}
    </div>
  );
}
