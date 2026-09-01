'use client';

import type { ComponentType } from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, ChevronDown, LayoutGrid, LayoutList, Search, Workflow, Plus } from 'lucide-react';
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, DragOverlay, closestCenter } from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useRenderNonce } from '@/hooks/use-render-nonce';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { useOrgDomainLabels } from '@/hooks/use-org-domain-labels';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast, ToastContainer } from '@/components/ui/toast';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { KanbanColumn } from './kanban-column';
import { KanbanTrustColumn } from './kanban-trust-column';
import { KanbanListView } from './kanban-list-view';
import { KanbanSkeleton } from './kanban-skeleton';
import { StoryDetailPanel } from './story-detail-panel';
import { StoryCard } from './story-card';
import { COLUMNS, TRUST_COLUMNS, TRUST_COLUMN_TO_STATUS, normalizeAssigneePatch, type KanbanStory, type KanbanSprint, type KanbanEpic, type KanbanMember, type ColumnId, type TrustColumnId, type DependencyEdge, type GateItem, type LineStatusSummary } from './types';
import type { LabelData } from '@/components/ui/label-chip';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * 터치는 드래그를 절대 시작하지 않게 — pointerType !== 'touch'만 드래그 활성(0d142311 prod 재발 근본 fix).
 * 마우스/펜 = 8px 드래그 유지 / 터치 = 센서 무시 → 네이티브 스크롤(touch-action pan-x pan-y 보장).
 * 타이밍 disambiguation(TouchSensor delay/tolerance) 포기·deterministic. 하이브리드(터치 노트북)도 마우스 드래그 유지.
 */
class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      // 좌클릭만 드래그(button===0) — 우/휠/보조 클릭은 dnd 게이트(산티아고 QA RC·dnd-kit 기본 PointerSensor 동등).
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
        nativeEvent.isPrimary && nativeEvent.button === 0 && nativeEvent.pointerType !== 'touch',
    },
  ];
}

type DragOverlayCompatProps = {
  children?: React.ReactNode;
  adjustScale?: boolean;
  className?: string;
  dropAnimation?: unknown;
  modifiers?: unknown[];
  style?: React.CSSProperties;
  transition?: string | undefined;
  wrapperElement?: keyof React.JSX.IntrinsicElements;
  zIndex?: number;
};
const DragOverlayCompat = DragOverlay as unknown as ComponentType<DragOverlayCompatProps>;

interface Task {
  id: string;
  title: string;
  status: string;
}

interface KanbanBoardProps {
  projectId?: string;
  wsSlug: string;
  projSlug: string;
}

// WIP limit localStorage 키
function wipLimitKey(projectId: string | undefined, status: string): string {
  return `wip_limit_${projectId ?? 'default'}_${status}`;
}

// Done 컬럼 collapse localStorage
function doneCollapseKey(projectId: string | undefined): string {
  return `done_collapsed_${projectId ?? 'default'}`;
}

function loadDoneCollapse(projectId: string | undefined): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(doneCollapseKey(projectId)) === 'true';
}

function saveDoneCollapse(projectId: string | undefined, collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(doneCollapseKey(projectId), String(collapsed));
}

function loadWipLimit(projectId: string | undefined, status: string): number | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(wipLimitKey(projectId, status));
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function saveWipLimit(projectId: string | undefined, status: string, limit: number | null): void {
  if (typeof window === 'undefined') return;
  if (limit === null) {
    localStorage.removeItem(wipLimitKey(projectId, status));
  } else {
    localStorage.setItem(wipLimitKey(projectId, status), String(limit));
  }
}

// story #2933 H4 — doneCollapseKey와 동형 localStorage 패턴(project별).
function axisModeKey(projectId: string | undefined): string {
  return `board_axis_mode_${projectId ?? 'default'}`;
}

// PO 긴급 fix(선생님 지적, 2026-08-22) — 방향서 P0-04 원문 «5-status를 보조 뷰로 남기고
// 기본 상태는 신뢰 파이프라인으로» = 기본값은 'trust'가 스펙. localStorage 미설정 시 'status'로
// 낙하하던 게 실측 결함(#2933 done 선언 당시 전원이 놓친 사각) — 명시적으로 저장된 'status'
// 선택만 존중하고, 그 외(미설정 포함)엔 'trust'로 낙하한다.
function loadAxisMode(projectId: string | undefined): 'status' | 'trust' {
  if (typeof window === 'undefined') return 'trust';
  return localStorage.getItem(axisModeKey(projectId)) === 'status' ? 'status' : 'trust';
}

function saveAxisMode(projectId: string | undefined, mode: 'status' | 'trust'): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(axisModeKey(projectId), mode);
}

export function KanbanBoard({ projectId, wsSlug, projSlug }: KanbanBoardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org)이 이 fetchData
  // *後* 성공하면 projectId는 안 바뀌므로 재요청 트리거가 없었다. 다른 opt-in 컴포넌트들과
  // 동일 패턴 — orgSyncVersion을 트리거 effect 의존성에 얹는다.
  const orgSyncVersion = useOrgSyncVersion();
  const t = useTranslations('board');
  const locale = useLocale();
  const { toasts, addToast, dismissToast } = useToast();
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // story #2154 — 이 배너는 4초 후 자동 setTransitionError(null)로만 해소되고, 재시도 直前에
  // 명시적으로 null 리셋하지 않는다(#2400이 남긴 latent gap). 4초 내 동일 사유가 재발하면
  // 텍스트가 안 바뀌어 재낭독이 안 될 수 있던 것을 nonce-key로 구조적으로 막는다.
  const [transitionErrorNonce, bumpTransitionErrorNonce] = useRenderNonce();
  const [stories, setStories] = useState<KanbanStory[]>([]);
  const [sprints, setSprints] = useState<KanbanSprint[]>([]);
  const [epics, setEpics] = useState<KanbanEpic[]>([]);
  const [members, setMembers] = useState<KanbanMember[]>([]);
  const [loading, setLoading] = useState(true);
  // CB-S4: status별 total count + cursor
  const [columnTotals, setColumnTotals] = useState<Record<string, number>>({});
  const [columnCursors, setColumnCursors] = useState<Record<string, string | null>>({});
  const [loadingMoreColumns, setLoadingMoreColumns] = useState<Record<string, boolean>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [epicsNextCursor, setEpicsNextCursor] = useState<string | null>(null);
  const [storyTasksNextCursor, setStoryTasksNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreEpics, setLoadingMoreEpics] = useState(false);
  const [loadingMoreStoryTasks, setLoadingMoreStoryTasks] = useState(false);

  const selectedSprintId = searchParams.get('sprint_id') ?? '';
  const selectedEpicId = searchParams.get('epic_id') ?? '';
  const selectedAssigneeId = searchParams.get('assignee_id') ?? '';

  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [assigneeTypeFilter, setAssigneeTypeFilter] = useState<'' | 'human' | 'agent'>('');
  // story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — 예전엔 이 state가 뷰포트 무관 'board'로
  // 하드코딩돼 있었다(유나 실측: flow-client의 view='list' 세그로 진입해도 여기서 다시
  // 'board'로 떨어져 3.55배 가로 overflow가 재발 — 이름이 같은 두 「board/list」 개념 충돌).
  // null=아직 사용자가 명시로 안 고름(URL이나 클릭 없음) → isMobile로 유도한 기본값을 쓴다.
  // 사용자가 토글 버튼을 누르면(setViewMode 직접 호출) 그 이후엔 뷰포트 변화와 무관하게
  // 그 선택을 고정 존중(flow-client.tsx의 `?view=` 우선·isMobile 폴백과 동일한 위계).
  const [viewModeOverride, setViewMode] = useState<'board' | 'list' | null>(null);
  const isMobile = useIsMobile();
  const viewMode = viewModeOverride ?? (isMobile ? 'list' : 'board');
  // story #2933 H4(P0-H) — 5-status/6단계 신뢰축 컬럼 축 토글. viewMode(board/list)와 직교
  // (list 뷰는 이번 슬라이스 스코프 밖 — trust 축은 board 렌더 안에서만). doneCollapsed와
  // 동형 localStorage 패턴(project별) — 재방문해도 마지막 선택 유지.
  const [axisMode, setAxisMode] = useState<'status' | 'trust'>('trust');
  useEffect(() => {
    setAxisMode(loadAxisMode(projectId));
  }, [projectId]);
  const handleSetAxisMode = useCallback((next: 'status' | 'trust') => {
    setAxisMode(next);
    saveAxisMode(projectId, next);
  }, [projectId]);
  const [sprintSearch, setSprintSearch] = useState('');
  const [epicSearch, setEpicSearch] = useState('');
  const [assigneeSearch, setAssigneeSearch] = useState('');

  const updateFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const storyId = searchParams.get('story');
    if (storyId) params.set('story', storyId);
    router.replace(`/${wsSlug}/${projSlug}/board${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams, wsSlug, projSlug]);

  // BOARD-03: done 컬럼 collapse 상태
  const [doneCollapsed, setDoneCollapsed] = useState(false);

  useEffect(() => {
    setDoneCollapsed(loadDoneCollapse(projectId));
  }, [projectId]);

  const handleToggleDoneCollapse = useCallback(() => {
    setDoneCollapsed((prev) => {
      const next = !prev;
      saveDoneCollapse(projectId, next);
      return next;
    });
  }, [projectId]);

  // AC1/AC5: WIP limit 상태 — 컬럼별 { limit: number|null, editing: boolean, draft: string }
  const [wipLimits, setWipLimits] = useState<Record<string, { limit: number | null; editing: boolean; draft: string }>>(() => {
    const initial: Record<string, { limit: number | null; editing: boolean; draft: string }> = {};
    for (const col of COLUMNS) {
      initial[col.id] = { limit: null, editing: false, draft: '' };
    }
    return initial;
  });

  // 클라이언트 마운트 후 localStorage에서 WIP limit 로드
  useEffect(() => {
    setWipLimits((prev) => {
      const next = { ...prev };
      for (const col of COLUMNS) {
        const stored = loadWipLimit(projectId, col.id);
        next[col.id] = { limit: stored, editing: false, draft: stored !== null ? String(stored) : '' };
      }
      return next;
    });
  }, [projectId]);

  const [executionMap, setExecutionMap] = useState<Record<string, { status: string; rule_name?: string | null; completed_at?: string | null }>>({});
  const [blockedByMap, setBlockedByMap] = useState<Record<string, string[]>>({});
  const [orgLabels, setOrgLabels] = useState<LabelData[]>([]);
  const [storyLabelsMap, setStoryLabelsMap] = useState<Record<string, LabelData[]>>({});
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [labelSearch, setLabelSearch] = useState('');
  const [storyGatesMap, setStoryGatesMap] = useState<Record<string, { id: string; gate_type: string; status: string }[]>>({});
  const [storyLineMap, setStoryLineMap] = useState<Record<string, LineStatusSummary>>({});

  const [selectedStory, setSelectedStory] = useState<KanbanStory | null>(null);
  const selectedStoryRef = useRef<KanbanStory | null>(null);
  selectedStoryRef.current = selectedStory;
  const [storyTasks, setStoryTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // 드래그는 non-touch pointer(마우스/펜)만 8px 이동으로 시작. 터치는 센서가 잡지 않아
  // 네이티브 스크롤만 동작(0d142311: PointerSensor가 터치도 잡던 + TouchSensor 타이밍 fragile 근본 제거).
  // 모바일 status 변경은 long-press 메뉴/드롭다운 경로 — touch-drag-reorder 상실은 product intent.
  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const epicMap: Record<string, string> = {};
  for (const e of epics) epicMap[e.id] = e.title;
  const memberMap: Record<string, KanbanMember> = {};
  for (const m of members) {
    memberMap[m.id] = m;
    const userId = (m as unknown as { user_id?: string | null }).user_id;
    if (userId) memberMap[userId] = m;
  }

  // CB-S4: status별 stories fetch helper
  const fetchStoriesByStatus = useCallback(async (status: string, cursor?: string): Promise<{ stories: KanbanStory[]; total: number; nextCursor: string | null }> => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (selectedSprintId) params.set('sprint_id', selectedSprintId);
    if (selectedAssigneeId) params.set('assignee_id', selectedAssigneeId);
    params.set('status', status);
    params.set('limit', status === 'done' ? '10' : '20');
    if (cursor) params.set('cursor', cursor);
    const res = await fetchWithAuth(`/api/stories?${params}`);
    if (!res.ok) return { stories: [], total: 0, nextCursor: null };
    // RC: 헤더 대신 JSON body meta에서 cursor/total 읽기 (proxy 헤더 strip 방지)
    const json = await res.json() as { data?: KanbanStory[]; meta?: { nextCursor?: string | null; hasMore?: boolean; total?: number } };
    const stories = json.data ?? [];
    const nextCursor = json.meta?.nextCursor ?? null;
    const total = json.meta?.total ?? stories.length;
    return { stories, total, nextCursor };
  }, [projectId, selectedSprintId, selectedAssigneeId]);

  // E-POLISH (story 23ea0e1d): columnTotals는 fetchData에서 단 1회 세팅되므로
  // optimistic mutation이 setStories만 갱신하면 카운트 배지가 stale해진다.
  // 컬럼 멤버십을 바꾸는 모든 경로에서 이 헬퍼로 per-status total을 lockstep 조정한다.
  const adjustColumnTotal = useCallback((status: string, delta: number) => {
    setColumnTotals((prev) => ({ ...prev, [status]: Math.max(0, (prev[status] ?? 0) + delta) }));
  }, []);

  // story #2059: 보드 실시간 반영 — 새 EventSource를 여는 대신 기존 useSseNotifications의
  // extraEventNames 확장 지점을 구독한다(AC2, 이미 이 용도로 설계된 재사용 경로 —
  // hooks/use-sse-notifications.ts 자체 문서 참고). story.status_changed/assignee_changed는
  // ⚠️(2026-07-23 정정, #2139/#2132) 실제로는 _push_to_agent(member_id) 경로로 프로젝트
  // 접근 가능한 멤버에게 개별 전송된다 — org 전체에 브로드캐스트하던 publish_event()는
  // 아무도 구독하지 않던 죽은 레지스트리였고 오늘 삭제됐다(과거엔 이 코멘트가 그렇게 적어뒀으나
  // 실제 배달 경로가 아니었다). project_id 클라 필터는 여전히 그대로 필요하다(수신 대상 멤버가
  // 여러 프로젝트에 접근 가능해 필터 없이는 다른 프로젝트 카드까지 반응할 수 있음).
  // 이미 로드된(페이지네이션으로 fetch된) 카드만 in-place 패치 — 전체 재fetch를 하지 않으므로
  // 스크롤 위치·컬럼 순서가 흔들리지 않는다(AC3, #2050에서 배운 레이아웃 시프트 축과 동일 원리).
  // 아직 로드 안 된 카드(다른 컬럼 페이지네이션 밖)의 신규 진입은 이 스토리 스코프 밖으로 둔다.
  const { currentTeamMemberId, orgId } = useDashboardContext();
  // story #3287([도메인탈고정·축1 Phase1]) — org별 표시 라벨 오버라이드. canonical
  // status(col.id, drag/전이/색상 전부 이걸로 판정)는 절대 안 바뀐다 — statusLabel()이
  // 있으면 그 문구로 컬럼 헤더 텍스트만 치환하고, 없으면(오버라이드 미설정) 기존
  // t(col.i18nKey) 그대로(회귀 0).
  const domainLabels = useOrgDomainLabels(orgId, locale);

  // story #2137 — 카드(stories 배열)와 상세 패널(selectedStory)이 별도 state라, SSE 패치를
  // stories에만 적용하면 패널만 옛값에 고정된다(#2384·#2130과 같은 클래스의 3번째 재발 — 이번엔
  // "갱신 신호를 아예 안 듣는 표면"). patchStory 하나로 묶어 두 state를 항상 같이 갱신해
  // "한쪽만 패치" 자체를 구조적으로 불가능하게 만든다 — 이 handler에 새 이벤트 분기가 추가돼도
  // 자동으로 이 보장을 물려받는다.
  const patchStoryFromSse = useCallback((storyId: string, patch: Partial<KanbanStory>) => {
    setStories((prev) => prev.map((s) => (s.id === storyId ? { ...s, ...patch } : s)));
    setSelectedStory((prev) => (prev && prev.id === storyId ? { ...prev, ...patch } : prev));
  }, []);

  const handleBoardSseEvent = useCallback((eventName: string, data: unknown) => {
    const payload = data as {
      story_id?: string;
      project_id?: string;
      actor_id?: string;
      actor_name?: string;
      status?: string;
      assignee_id?: string | null;
      assignees?: string[];
      position?: number;
    };
    if (!payload.story_id || !payload.project_id || payload.project_id !== projectId) return;
    // 내 액션의 echo는 무시 — 이미 낙관 갱신했으므로 중복 패치·토스트 스팸을 방지한다.
    if (currentTeamMemberId && payload.actor_id === currentTeamMemberId) return;

    const existing = stories.find((s) => s.id === payload.story_id);
    if (!existing) return;

    const titleForToast = existing.title;
    if (eventName === 'story.status_changed' && payload.status && payload.status !== existing.status) {
      const newStatus = payload.status;
      patchStoryFromSse(payload.story_id, { status: newStatus });
      adjustColumnTotal(existing.status, -1);
      adjustColumnTotal(newStatus, +1);
    } else if (eventName === 'story.assignee_changed') {
      // story #2133 — normalizeAssigneePatch가 assignee_id/assignee_ids 정합을 강제한다.
      // 손으로 두 필드를 따로 계산하던 자리(#2130 근본)를 구조로 제거.
      const assigneePatch = normalizeAssigneePatch({ assignee_id: payload.assignee_id, assignee_ids: payload.assignees });
      patchStoryFromSse(payload.story_id, assigneePatch);
    } else if (eventName === 'story.position_changed' && typeof payload.position === 'number' && payload.position !== existing.position) {
      // story #2172 AC5 — BE는 이미 발행하고 있었으나(#2476) FE 구독이 없어 "프레임은 나가는데
      // 아무도 안 받는" 죽은 경로였다(#2131이 고친 "프레임이 출발조차 안 함"의 거울상). 컬럼
      // 렌더가 이미 position으로 정렬하므로(위 columnStories 계산부) position만 patch하면
      // 재정렬은 그 정렬 로직이 그대로 이어받는다 — 별도 재배치 코드 불요.
      patchStoryFromSse(payload.story_id, { position: payload.position });
    } else {
      return;
    }

    // AC4: 카드가 그냥 이동하지 않는다 — 누가 했는지 토스트로 드러낸다(안 그러면 사람은
    // 자기 화면이 오작동한 것으로 읽는다).
    const actorLabel = payload.actor_name ?? t('realtimeUnknownActor');
    addToast({
      type: 'info',
      title: eventName === 'story.status_changed'
        ? t('realtimeStatusChanged', { actor: actorLabel, title: titleForToast })
        : eventName === 'story.assignee_changed'
          ? t('realtimeAssigneeChanged', { actor: actorLabel, title: titleForToast })
          : t('realtimePositionChanged', { actor: actorLabel, title: titleForToast }),
    });
  }, [projectId, currentTeamMemberId, stories, adjustColumnTotal, addToast, t, patchStoryFromSse]);

  useSseNotifications({
    memberId: currentTeamMemberId,
    extraEventNames: ['story.status_changed', 'story.assignee_changed', 'story.position_changed'],
    onExtraEvent: handleBoardSseEvent,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const sprintParams = projectId ? `?project_id=${projectId}` : '';
      const epicParams = new URLSearchParams();
      if (projectId) epicParams.set('project_id', projectId);
      epicParams.set('limit', '20');
      const memberParams = projectId ? `?project_id=${projectId}` : '';

      // CB-S4: status별 5회 독립 호출
      const statuses = COLUMNS.map((c) => c.id);
      const [storyResults, sprintsRes, epicsRes, membersRes] = await Promise.all([
        Promise.all(statuses.map((s) => fetchStoriesByStatus(s))),
        fetchWithAuth(`/api/sprints${sprintParams}`),
        fetchWithAuth(`/api/goals?${epicParams.toString()}`),
        fetchWithAuth(`/api/members${memberParams}`),
      ]);

      const allStories: KanbanStory[] = [];
      const newTotals: Record<string, number> = {};
      const newCursors: Record<string, string | null> = {};
      statuses.forEach((s, i) => {
        allStories.push(...storyResults[i].stories);
        newTotals[s] = storyResults[i].total;
        newCursors[s] = storyResults[i].nextCursor;
      });
      setStories(allStories);
      setColumnTotals(newTotals);
      setColumnCursors(newCursors);

      const storyIds = allStories.map((s) => s.id);
      if (sprintsRes.ok) { const json = await sprintsRes.json(); setSprints(json.data); }
      if (epicsRes.ok) { const json = await epicsRes.json(); setEpics(json.data); setEpicsNextCursor(json.meta?.nextCursor ?? null); }
      if (membersRes.ok) { const json = await membersRes.json(); setMembers(json.data); }

      if (projectId && storyIds.length > 0) {
        try {
          const summaryParams = new URLSearchParams({ project_id: projectId });
          for (const sid of storyIds) summaryParams.append('story_ids', sid);
          const summaryRes = await fetchWithAuth(`/api/workflow-executions/story-summary?${summaryParams.toString()}`);
          if (summaryRes.ok) {
            const summaryJson = await summaryRes.json() as Record<string, { status: string; rule_name?: string | null; completed_at?: string | null }>;
            setExecutionMap(summaryJson);
          }
        } catch {
          // non-critical — skip silently
        }
      }

      // S11 ①: workflow-line 상태 배치(보드 카드 badge)·N+1 0(1 fetch/200건·chunk·silent 캡 없음). storyIds 기준.
      if (storyIds.length > 0) {
        try {
          const chunks: string[][] = [];
          for (let i = 0; i < storyIds.length; i += 200) chunks.push(storyIds.slice(i, i + 200));
          const results = await Promise.all(chunks.map((chunk) =>
            fetchWithAuth(`/api/stories/workflow-line/status?ids=${chunk.join(',')}`)
              .then((r) => (r.ok ? (r.json() as Promise<LineStatusSummary[]>) : []))
              .catch(() => []),
          ));
          const lmap: Record<string, LineStatusSummary> = {};
          for (const arr of results) for (const s of arr) lmap[s.story_id] = s;
          setStoryLineMap(lmap);
        } catch {
          // non-critical — line badge 없으면 카드는 기존대로 렌더.
        }
      }

      try {
        const graphRes = await fetchWithAuth('/api/dependencies/graph?item_type=story');
        if (graphRes.ok) {
          const graphJson = await graphRes.json() as { edges?: DependencyEdge[] };
          const map: Record<string, string[]> = {};
          for (const edge of graphJson.edges ?? []) {
            if (edge.dep_type === 'blocks') {
              if (!map[edge.to_id]) map[edge.to_id] = [];
              map[edge.to_id].push(edge.from_id);
            }
          }
          setBlockedByMap(map);
        }
      } catch {
        // non-critical
      }

      try {
        const labelsRes = await fetchWithAuth('/api/labels');
        if (labelsRes.ok) {
          const labelsJson = await labelsRes.json() as LabelData[];
          setOrgLabels(labelsJson);
          try {
            const ilRes = await fetchWithAuth('/api/item-labels?item_type=story');
            if (ilRes.ok) {
              const itemLabels = await ilRes.json() as { item_id: string; label_id: string }[];
              const map: Record<string, LabelData[]> = {};
              for (const il of itemLabels) {
                const label = labelsJson.find((l) => l.id === il.label_id);
                if (label) (map[il.item_id] ??= []).push(label);
              }
              setStoryLabelsMap(map);
            }
          } catch {
            // non-critical
          }
        }
      } catch {
        // non-critical
      }

      try {
        const gatesRes = await fetchWithAuth('/api/gates?status=pending&work_item_type=story');
        if (gatesRes.ok) {
          const gatesJson = await gatesRes.json() as GateItem[];
          const gmap: Record<string, { id: string; gate_type: string; status: string }[]> = {};
          for (const g of gatesJson) {
            if (!gmap[g.work_item_id]) gmap[g.work_item_id] = [];
            gmap[g.work_item_id].push({ id: g.id, gate_type: g.gate_type, status: g.status });
          }
          setStoryGatesMap(gmap);
        }
      } catch {
        // non-critical
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, fetchStoriesByStatus]);

  // CB-S4: 컬럼별 "더 보기" 핸들러
  const handleLoadMore = useCallback(async (status: string) => {
    const cursor = columnCursors[status];
    if (!cursor) return;
    setLoadingMoreColumns((prev) => ({ ...prev, [status]: true }));
    try {
      const result = await fetchStoriesByStatus(status, cursor);
      setStories((prev) => [...prev, ...result.stories]);
      setColumnCursors((prev) => ({ ...prev, [status]: result.nextCursor }));
    } finally {
      setLoadingMoreColumns((prev) => ({ ...prev, [status]: false }));
    }
  }, [columnCursors, fetchStoriesByStatus]);

  useEffect(() => { void fetchData(); }, [fetchData, orgSyncVersion]);


  const handleStoryClick = useCallback(async (story: KanbanStory, { replace = false } = {}) => {
    setSelectedStory(story);
    setStoryTasksNextCursor(null);

    // URL에 스토리 ID 반영
    const params = new URLSearchParams(searchParams);
    params.set('story', story.id);
    if (replace) {
      router.replace(`?${params.toString()}`, { scroll: false });
    } else {
      router.push(`?${params.toString()}`, { scroll: false });
    }

    try {
      const res = await fetchWithAuth(`/api/tasks?story_id=${story.id}&limit=20`);
      if (res.ok) {
        const json = await res.json();
        setStoryTasks(json.data ?? []);
        setStoryTasksNextCursor(json.meta?.nextCursor ?? null);
      }
    } catch {
      setStoryTasks([]);
      setStoryTasksNextCursor(null);
    }
  }, [searchParams, router]);

  const handleCloseStory = useCallback(() => {
    setSelectedStory(null);

    // URL에서 스토리 ID 제거
    const params = new URLSearchParams(searchParams);
    params.delete('story');
    router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
  }, [searchParams, router]);

  // f1910a31: ?view=new → 백로그 인라인 컴포저 auto-open(client nav·풀로드 둘 다). nonce로 신호 전달해
  // 반복 진입도 재오픈되게 한다. one-shot으로 ?view=new를 즉시 제거(뒤로가기/재렌더 재오픈 방지·URL 정리).
  const [autoComposeNonce, setAutoComposeNonce] = useState(0);
  useEffect(() => {
    if (searchParams.get('view') !== 'new') return;
    setAutoComposeNonce((n) => n + 1);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('view');
    router.replace(`/${wsSlug}/${projSlug}/board${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [searchParams, router, wsSlug, projSlug]);

  // URL에서 스토리 ID 읽어서 자동으로 패널 열기
  useEffect(() => {
    const storyId = searchParams.get('story');
    if (!storyId) return;
    if (selectedStoryRef.current?.id === storyId) return;

    const story = stories.find((s) => s.id === storyId);
    if (story) {
      void handleStoryClick(story, { replace: true });
    } else if (stories.length > 0) {
      // 현재 보드에 없는 스토리 — 직접 fetch 후 패널 오픈
      fetchWithAuth(`/api/stories/${storyId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          const fetched = json?.data as KanbanStory | undefined;
          if (fetched && selectedStoryRef.current?.id !== storyId) {
            void handleStoryClick(fetched, { replace: true });
          }
        })
        .catch(() => {});
    }
  }, [searchParams, stories, handleStoryClick]);

  // URL에서 task_id 읽어서 해당 task의 story 패널 열기 (알림 딥링크 지원)
  useEffect(() => {
    const taskId = searchParams.get('task_id');
    if (!taskId || stories.length === 0) return;

    fetchWithAuth(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const storyId = json?.data?.story_id as string | undefined;
        if (!storyId || selectedStoryRef.current?.id === storyId) return;
        const story = stories.find((s) => s.id === storyId);
        if (story) {
          void handleStoryClick(story, { replace: true });
        } else {
          fetchWithAuth(`/api/stories/${storyId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((json2) => {
              const fetched = json2?.data as KanbanStory | undefined;
              if (fetched && selectedStoryRef.current?.id !== storyId) {
                void handleStoryClick(fetched, { replace: true });
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [searchParams, stories, handleStoryClick]);

  // story #2187 — is_excluded=true(라이브 QA 임시 카드 등)는 무조건 숨긴다. 다른 필터와 달리
  // 토글이 없다 — 삭제 권한이 없어 화면에서라도 항상 빠져야 「«남은 일»을 과장」하지 않는다.
  const excludedCount = stories.filter((s) => s.is_excluded).length;

  const filteredStories = stories.filter((s) => {
    if (s.is_excluded) return false;
    if (selectedEpicId && s.epic_id !== selectedEpicId) return false;
    // 9f25e74a AC1: assignee 필터는 서버사이드(fetchStoriesByStatus ?assignee_id=)로 이관 — 클라 이중필터 제거(done 페이지네이션 경계 AC2 동시 해소).
    if (assigneeTypeFilter) {
      const assignee = s.assignee_id ? memberMap[s.assignee_id] : null;
      if (assigneeTypeFilter === 'agent' && assignee?.type !== 'agent') return false;
      if (assigneeTypeFilter === 'human' && assignee?.type === 'agent') return false;
    }
    if (selectedLabelIds.length > 0) {
      const storyLabelIds = (storyLabelsMap[s.id] ?? []).map((l) => l.id);
      const hasAny = selectedLabelIds.some((id) => storyLabelIds.includes(id));
      if (!hasAny) return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const titleMatch = s.title?.toLowerCase().includes(q);
      const assigneeName = s.assignee_id ? memberMap[s.assignee_id]?.name?.toLowerCase() : '';
      const assigneeMatch = assigneeName?.includes(q);
      if (!titleMatch && !assigneeMatch) return false;
    }
    return true;
  });

  // counter fix: 필터 활성 시 column counter는 filtered(로드된) 개수, 비활성 시 백엔드 total(페이지네이션 "20+" 유지).
  const filterActive = Boolean(
    selectedEpicId || selectedAssigneeId || assigneeTypeFilter || selectedLabelIds.length > 0 || searchQuery,
  );
  // 9f25e74a AC1/AC2: assignee/sprint은 서버필터(cursor 페이지네이션)라 '더보기' 억제 대상서 제외 —
  // 클라필터(epic/type/labels/search)만 hasMore 억제. assignee 필터 done이 10+ 여도 필터집합 cursor로 페이지네이션(누락 0).
  const clientFilterActive = Boolean(
    selectedEpicId || assigneeTypeFilter || selectedLabelIds.length > 0 || searchQuery,
  );

  // position 기준으로 정렬
  const storiesByColumn = (columnId: string): KanbanStory[] => {
    const col = filteredStories.filter((s) => s.status === columnId);
    return [...col].sort((a, b) => {
      const pa = a.position ?? 0;
      const pb = b.position ?? 0;
      return pa - pb;
    });
  };

  const handleDragStart = (event: { active: { id: string | number } }) => {
    setActiveId(String(event.active.id));
  };

  const resolveColumnId = (overId: string): ColumnId | null => {
    // over.id가 컬럼 id인 경우
    const isColumn = COLUMNS.some((c) => c.id === overId);
    if (isColumn) return overId as ColumnId;

    // over.id가 story id인 경우 — 해당 story의 status를 컬럼으로 사용
    const targetStory = stories.find((s) => s.id === overId);
    if (targetStory) return targetStory.status as ColumnId;

    return null;
  };

  // story #2933 H4(P0-H, v4 아티팩트 e65f1016) — story→트러스트 컬럼 매핑. SSOT는 BE
  // trust_pipeline.derive_trust_stage()(H1이 story.trust_stage로 노출) — FE는 그 값을 그대로
  // 컬럼 판별자로 읽을 뿐 재계산하지 않는다(PO 지침 (a), 구 story-detail-panel:769류 폐기된
  // FE 재파생 반복 금지). done만 예외 — derive_trust_stage가 done을 None으로 반환해(파이프라인
  // 밖) trust_stage 하나만으론 done 여부를 못 가른다(같은 None이 "미지 status"와 안 구분되는
  // H1 스키마의 정직한 한계, story.py trust_stage 필드 주석과 동형) — status==='done'을 별도로
  // 대조해 7번째 «완료» 컬럼으로 보낸다.
  const storyTrustColumn = (s: KanbanStory): TrustColumnId | null => {
    if (s.status === 'done') return 'done';
    return (s.trust_stage as TrustColumnId | null) ?? null;
  };

  const isLockedTrustColumn = (columnId: TrustColumnId): boolean =>
    TRUST_COLUMNS.find((c) => c.id === columnId)?.locked ?? false;

  // 파생 3컬럼(needs_input/verified/merge_ready)은 드롭 타깃으로 절대 해소되지 않는다(잠금) —
  // v4 결정⑤ "파생서 카드 빼는 길=게이트 해소뿐". 컬럼 자체에 드롭하든 그 컬럼의 카드 위에
  // 드롭하든 동일하게 null(드롭 무효)을 반환해 handleTrustDragEnd가 조용히 무시하게 한다.
  const resolveTrustColumnId = (overId: string): TrustColumnId | null => {
    const asColumn = TRUST_COLUMNS.find((c) => c.id === overId);
    if (asColumn) return asColumn.locked ? null : asColumn.id;

    const targetStory = stories.find((s) => s.id === overId);
    if (targetStory) {
      const col = storyTrustColumn(targetStory);
      if (col && isLockedTrustColumn(col)) return null;
      return col;
    }
    return null;
  };

  const computeNewTrustPosition = (
    columnStories: KanbanStory[],
    storyId: string,
    overId: string,
  ): number => {
    const overStory = columnStories.find((s) => s.id === overId);
    if (!overStory) {
      const sorted = [...columnStories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const last = sorted[sorted.length - 1];
      return last ? (last.position ?? 0) + 1000 : 1000;
    }
    const sorted = [...columnStories.filter((s) => s.id !== storyId)]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const overIdx = sorted.findIndex((s) => s.id === overId);
    if (overIdx === -1) {
      const last = sorted[sorted.length - 1];
      return last ? (last.position ?? 0) + 1000 : 1000;
    }
    const prev = sorted[overIdx - 1];
    const next = sorted[overIdx];
    const prevPos = prev?.position ?? (next.position ?? 0) - 2000;
    const nextPos = next?.position ?? prevPos + 2000;
    return Math.round((prevPos + nextPos) / 2);
  };

  // story #2933 H4 — handleDragEnd의 트러스트축 형제. 판별자만 다르다(status 동등비교 대신
  // storyTrustColumn 동등비교) — 그래서 PO 지침(b)이 저절로 성립한다: queued 컬럼이 backlog+
  // ready-for-dev 둘 다 담아도, "같은 트러스트 컬럼 안에서" 재정렬(예: backlog 카드를 그
  // 컬럼의 ready-for-dev 카드보다 위로 끌기)은 isSameTrustColumn=true라 position-only PATCH만
  // 타고 status는 절대 안 건드린다 — backlog 카드가 컬럼 내 이동만으로 승격되지 않는다.
  const handleTrustDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const storyId = String(active.id);
    const overId = String(over.id);
    const newTrustColumn = resolveTrustColumnId(overId);
    if (!newTrustColumn) return; // 파생 컬럼 드롭 시도 등 — 조용히 무효(스냅백, PATCH 0건).

    const story = stories.find((s) => s.id === storyId);
    if (!story) return;
    const oldTrustColumn = storyTrustColumn(story);
    if (!oldTrustColumn) return; // 드래그 시작 카드 자체가 파생 컬럼 소속 — useSortable disabled로 애초 안 잡히지만 방어.

    const isSameTrustColumn = oldTrustColumn === newTrustColumn;
    const targetColumnStories = stories.filter((s) => storyTrustColumn(s) === newTrustColumn);
    const newPosition = computeNewTrustPosition(targetColumnStories, storyId, overId);

    if (isSameTrustColumn) {
      setStories((prev) => prev.map((s) => (s.id === storyId ? { ...s, position: newPosition } : s)));
      void fetch(`/api/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: newPosition }),
      });
      return;
    }

    // PO 지침④ — queued로의 이동은 항상 ready-for-dev로 승격(backlog 강등은 이 뷰에서 안 함).
    const newStatus = TRUST_COLUMN_TO_STATUS[newTrustColumn];
    if (!newStatus) return; // 이론상 도달 불가(resolveTrustColumnId가 이미 locked를 거름) — 방어.

    setStories((prev) =>
      prev.map((s) => (s.id === storyId ? { ...s, status: newStatus, position: newPosition } : s)),
    );

    try {
      const res = await fetch('/api/stories/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
      });
      if (!res.ok) {
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
        );
        const errJson = await res.json().catch(() => null);
        if (errJson?.error?.code === 'FORBIDDEN') {
          bumpTransitionErrorNonce();
          setTransitionError(t('transitionDenied'));
          setTimeout(() => setTransitionError(null), 4000);
        }
        return;
      }
      const okItems = await res.json().then((j) => j?.data ?? j).catch(() => null);
      const okItem = Array.isArray(okItems) ? okItems.find((x) => x?.id === storyId) : null;
      const violation = okItem?.violation ?? null;
      if (violation) addToast({ type: 'warning', title: t('transitionViolation') });
      // story #2933 H4 qa:changes(카디르+codex, 2026-08-22) — 위 낙관 갱신(L764-766)은
      // status/position만 바꿔 trust_stage는 이전 값 그대로 스프레드된다. queued→running
      // 이동은 카드가 옛 컬럼(queued)에 그대로 남고, done 카드를 다른 컬럼으로 옮기면
      // trust_stage=null이 유지돼(그 카드가 done이던 동안 원래 null이었으므로) status만
      // 바뀐 뒤에는 storyTrustColumn이 어느 컬럼과도 안 맞아 카드가 보드에서 실종된다. 서버가
      // 이제(backend/app/routers/stories.py bulk_update_stories에 _attach_trust_stage 배선
      // 추가) 계산해 돌려준 진짜 trust_stage를 응답 도착 시점에 병합 — 재파생 폴백 아님(PO
      // 조건② 그대로, BE 판정값을 그대로 반영할 뿐).
      if (okItem && 'trust_stage' in okItem) {
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, trust_stage: okItem.trust_stage ?? null } : s)),
        );
      }
      void fetch(`/api/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: newPosition }),
      });
    } catch {
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
      );
    }
  };

  // story #2933 H4 — storiesByColumn의 트러스트축 형제(status 동등비교 대신 storyTrustColumn).
  const storiesByTrustColumn = (columnId: TrustColumnId): KanbanStory[] => {
    const col = filteredStories.filter((s) => storyTrustColumn(s) === columnId);
    return [...col].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  };

  // AC4: 드래그 완료 후 position gap 계산
  const computeNewPosition = (
    columnStories: KanbanStory[],
    storyId: string,
    overId: string,
    newStatus: ColumnId,
  ): number => {
    // 같은 컬럼 내 재정렬: over.id가 story id인 경우
    const overStory = columnStories.find((s) => s.id === overId);
    if (!overStory) {
      // 빈 컬럼이거나 컬럼 자체에 드롭 — 마지막에 추가
      const sorted = [...columnStories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const last = sorted[sorted.length - 1];
      return last ? (last.position ?? 0) + 1000 : 1000;
    }

    const sorted = [...columnStories.filter((s) => s.id !== storyId && s.status === newStatus)]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const overIdx = sorted.findIndex((s) => s.id === overId);
    if (overIdx === -1) {
      const last = sorted[sorted.length - 1];
      return last ? (last.position ?? 0) + 1000 : 1000;
    }

    const prev = sorted[overIdx - 1];
    const next = sorted[overIdx];
    const prevPos = prev?.position ?? (next.position ?? 0) - 2000;
    const nextPos = next?.position ?? prevPos + 2000;
    return Math.round((prevPos + nextPos) / 2);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const storyId = String(active.id);
    const overId = String(over.id);
    const newStatus = resolveColumnId(overId);
    if (!newStatus) return;

    const story = stories.find((s) => s.id === storyId);
    if (!story) return;

    const isSameColumn = story.status === newStatus;

    // 정공법 A(c1cd484b): 어느 칸→어느 칸 자유 이동. FE 하드reject 제거 — 비정상 점프는
    // BE가 위반(warn)으로 기록하고 차단하지 않는다(메뉴 경로와 거동 일관). done reopen 허용.

    // AC4: 새 position 계산
    const targetColumnStories = stories.filter((s) => s.status === newStatus);
    const newPosition = computeNewPosition(targetColumnStories, storyId, overId, newStatus);

    // 낙관적 업데이트
    setStories((prev) =>
      prev.map((s) => (s.id === storyId ? { ...s, status: newStatus, position: newPosition } : s)),
    );
    // cross-column 이동만 카운트 변동 (same-column 재정렬은 무변경)
    if (!isSameColumn) {
      adjustColumnTotal(story.status, -1);
      adjustColumnTotal(newStatus, +1);
    }

    if (isSameColumn) {
      // 같은 컬럼 내 재정렬 — position만 PATCH (fire-and-forget)
      void fetch(`/api/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: newPosition }),
      });
      return;
    }

    // 다른 컬럼으로 이동 — status + position PATCH
    try {
      const res = await fetch('/api/stories/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
      });
      if (!res.ok) {
        // 정공법 A: 전이 자체는 차단 안 됨 — 권한(FORBIDDEN) 등 실 실패만 롤백.
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
        );
        adjustColumnTotal(newStatus, -1);
        adjustColumnTotal(story.status, +1);
        const errJson = await res.json().catch(() => null);
        if (errJson?.error?.code === 'FORBIDDEN') {
          bumpTransitionErrorNonce();
          setTransitionError(t('transitionDenied'));
          setTimeout(() => setTransitionError(null), 4000);
        }
        return;
      }
      // 정공법 A: 비순차 점프는 BE가 violation(warn)으로 기록·차단X → 비차단 인디케이터 표시.
      const okItems = await res.json().then((j) => j?.data ?? j).catch(() => null);
      const violation = Array.isArray(okItems) ? okItems.find((x) => x?.id === storyId)?.violation : null;
      if (violation) addToast({ type: 'warning', title: t('transitionViolation') });
      // status 성공 후 position fire-and-forget
      void fetch(`/api/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: newPosition }),
      });
    } catch {
      // 롤백 (카운트도 원복)
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
      );
      adjustColumnTotal(newStatus, -1);
      adjustColumnTotal(story.status, +1);
    }
  };

  const handleEditStory = useCallback((storyId: string) => {
    const story = stories.find((s) => s.id === storyId);
    if (story) {
      void handleStoryClick(story);
    }
  }, [stories, handleStoryClick]);

  const handleChangeStatus = useCallback(async (storyId: string, newStatus: string) => {
    const story = stories.find((s) => s.id === storyId);
    if (!story || story.status === newStatus) return;

    // Optimistic update
    setStories((prev) =>
      prev.map((s) => (s.id === storyId ? { ...s, status: newStatus } : s)),
    );
    adjustColumnTotal(story.status, -1);
    adjustColumnTotal(newStatus, +1);

    // API call
    try {
      const res = await fetch('/api/stories/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
      });
      if (!res.ok) {
        // 정공법 A: 전이 자체는 차단 안 됨 — 권한(FORBIDDEN) 등 실 실패만 롤백.
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
        );
        adjustColumnTotal(newStatus, -1);
        adjustColumnTotal(story.status, +1);
        const errJson = await res.json().catch(() => null);
        if (errJson?.error?.code === 'FORBIDDEN') {
          bumpTransitionErrorNonce();
          setTransitionError(t('transitionDenied'));
          setTimeout(() => setTransitionError(null), 4000);
        }
        return;
      }
      // 정공법 A: 비순차 점프 violation(warn) 비차단 표시(메뉴 경로도 드래그와 동일 거동).
      const okItems = await res.json().then((j) => j?.data ?? j).catch(() => null);
      const violation = Array.isArray(okItems) ? okItems.find((x) => x?.id === storyId)?.violation : null;
      if (violation) addToast({ type: 'warning', title: t('transitionViolation') });
    } catch {
      // Rollback (카운트도 원복)
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
      );
      adjustColumnTotal(newStatus, -1);
      adjustColumnTotal(story.status, +1);
    }
  }, [stories, t, adjustColumnTotal, addToast, bumpTransitionErrorNonce]);

  const handleAssignStory = useCallback(async (storyId: string) => {
    // TODO: Implement proper member selection UI
    // For now, just open the detail panel
    const story = stories.find((s) => s.id === storyId);
    if (story) {
      void handleStoryClick(story);
    }
  }, [stories, handleStoryClick]);

  const handleDeleteStory = useCallback(async (storyId: string) => {
    const story = stories.find((s) => s.id === storyId);
    // Optimistic update
    setStories((prev) => prev.filter((s) => s.id !== storyId));
    if (story) adjustColumnTotal(story.status, -1);

    try {
      const res = await fetch(`/api/stories/${storyId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        // story #2485 — backend delete_story()는 generic HTTP상태 코드만 낸다(진짜
        // 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
        addToast({ type: 'error', title: '스토리 삭제에 실패했습니다.' });
        await fetchData(); // 카운트/스토리 전량 재동기화 (수동 롤백 불필요)
      }
    } catch {
      addToast({ type: 'error', title: '스토리 삭제에 실패했습니다.' });
      await fetchData();
    }
  }, [stories, fetchData, addToast, adjustColumnTotal]);

  const handleKickoff = useCallback((_storyId: string, result: 'triggered' | 'no_match' | 'conflict' | 'error') => {
    const messages: Record<string, { title: string; type: 'success' | 'error' | 'info' | 'warning' }> = {
      triggered: { title: t('kickoffTriggered'), type: 'success' },
      no_match: { title: t('kickoffNoMatch'), type: 'info' },
      conflict: { title: t('kickoffConflict'), type: 'warning' },
      error: { title: t('kickoffError'), type: 'error' },
    };
    const msg = messages[result] ?? { title: t('kickoffError'), type: 'error' };
    addToast({ title: msg.title, type: msg.type });
  }, [t, addToast]);

  const handleCreateStory = useCallback(async (columnId: string, title: string) => {
    if (!projectId) return;
    try {
      const res = await fetch('/api/stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          title,
          status: columnId,
          priority: 'medium',
          ...(selectedSprintId ? { sprint_id: selectedSprintId } : {}),
          ...(selectedEpicId ? { epic_id: selectedEpicId } : {}),
        }),
      });
      if (!res.ok) {
        bumpTransitionErrorNonce();
        setTransitionError(t('createStoryFailed'));
        return;
      }
      const json = await res.json();
      const created = json.data as KanbanStory;
      setStories((prev) => [...prev, created]);
      // 카드 렌더 컬럼(created.status)과 카운트를 동일 source로 정합 — BE가 status를 정규화해도 무어긋남
      adjustColumnTotal(created.status, +1);
    } catch {
      bumpTransitionErrorNonce();
      setTransitionError(t('createStoryFailed'));
    }
  }, [projectId, selectedSprintId, selectedEpicId, t, adjustColumnTotal, bumpTransitionErrorNonce]);

  // story #2949 — 트러스트 뷰의 인라인 컴포저는 TrustColumnId(예: 'queued')를 넘긴다.
  // handleCreateStory는 그 값을 그대로 story.status로 POST하므로(classic 뷰는 컬럼id=status라
  // 문제 없음), TRUST_COLUMN_TO_STATUS(H4 확定 매핑, 드롭과 동일 규칙)로 실 status를 먼저
  // 해소한 뒤 위임한다 — 생성 로직 자체는 발명 0(같은 handleCreateStory 재사용).
  const handleCreateStoryTrust = useCallback((columnId: string, title: string) => {
    const status = TRUST_COLUMN_TO_STATUS[columnId as TrustColumnId] ?? columnId;
    return handleCreateStory(status, title);
  }, [handleCreateStory]);

  // AC1/AC5: WIP limit 핸들러
  const handleWipLimitEdit = useCallback((columnId: string) => {
    setWipLimits((prev) => ({
      ...prev,
      [columnId]: {
        ...prev[columnId],
        editing: true,
        draft: prev[columnId]?.limit !== null ? String(prev[columnId]?.limit) : '',
      },
    }));
  }, []);

  const handleWipLimitSave = useCallback((columnId: string) => {
    setWipLimits((prev) => {
      const draft = prev[columnId]?.draft ?? '';
      const n = parseInt(draft, 10);
      const limit = !isNaN(n) && n > 0 ? n : null;
      saveWipLimit(projectId, columnId, limit);
      return {
        ...prev,
        [columnId]: { limit, editing: false, draft: limit !== null ? String(limit) : '' },
      };
    });
  }, [projectId]);

  const handleWipLimitRemove = useCallback((columnId: string) => {
    saveWipLimit(projectId, columnId, null);
    setWipLimits((prev) => ({
      ...prev,
      [columnId]: { limit: null, editing: false, draft: '' },
    }));
  }, [projectId]);

  const handleWipLimitDraftChange = useCallback((columnId: string, value: string) => {
    setWipLimits((prev) => ({
      ...prev,
      [columnId]: { ...prev[columnId], draft: value },
    }));
  }, []);

  const activeStory = activeId ? stories.find((s) => s.id === activeId) : null;
  const dragStatus = activeStory?.status ?? null;

  if (loading) return <KanbanSkeleton />;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {transitionError && (
        // story #2154 — handleDragEnd/handleChangeStatus/handleCreateStory가 실패 시점마다
        // bumpTransitionErrorNonce()를 함께 호출해, 4초 내 동일 사유가 재발해도 key가 바뀌어
        // 항상 새 DOM 노드로 재낭독된다(#2400이 남긴 latent gap 해소).
        // story #3007(로드맵 P2·PR-E, L1) — 토스트성 배너는 floating이라 --elev-overlay.
        <div key={transitionErrorNonce} role="alert" aria-live="assertive" aria-atomic="true" className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-[var(--elev-overlay)]">
          ⚠️ {transitionError}
        </div>
      )}

      {/* Board header */}
      <div className="flex min-h-11 flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/80 px-4 py-1.5">
        {/* Left: assignee type tabs + filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {([
            { id: '' as const, label: t('filterAll') },
            { id: 'human' as const, label: t('filterMembers') },
            { id: 'agent' as const, label: t('filterAgents') },
          ]).map(({ id, label }) => (
            <Button
              key={id || 'all'}
              type="button"
              variant="ghost"
              onClick={() => setAssigneeTypeFilter(id)}
              className={`h-auto min-h-0 min-w-0 rounded-md px-3 py-1.5 text-xs font-medium ${
                assigneeTypeFilter === id
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {label}
            </Button>
          ))}

          <div className="mx-1 h-4 w-px bg-border/60" />

          {/* Sprint chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setSprintSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className={`h-7 min-h-0 min-w-0 gap-1 rounded-md border px-2 text-xs font-medium ${
                    selectedSprintId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedSprintId ? (sprints.find((s) => s.id === selectedSprintId)?.title ?? t('allSprints')) : t('allSprints')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-56">
              <div className="p-1">
                <Input
                  autoFocus
                  value={sprintSearch}
                  onChange={(e) => setSprintSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t('searchSprints')}
                  className="h-7 text-xs"
                />
              </div>
              <DropdownMenuSeparator />
              <div className="focus-inset max-h-[50vh] overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => updateFilter('sprint_id', '')}>
                    <span className="flex-1">{t('allSprints')}</span>
                    {!selectedSprintId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                  {(() => {
                    const filtered = sprints.filter((s) => s.title.toLowerCase().includes(sprintSearch.toLowerCase()));
                    if (filtered.length === 0) {
                      return <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('noResults')}</div>;
                    }
                    return filtered.map((s) => (
                      <DropdownMenuItem key={s.id} onClick={() => updateFilter('sprint_id', s.id)}>
                        <span className="flex-1 truncate">{s.title}</span>
                        {s.id === selectedSprintId && <Check className="size-3.5 text-primary" />}
                      </DropdownMenuItem>
                    ));
                  })()}
                </DropdownMenuGroup>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => router.push(`/${wsSlug}/${projSlug}/sprints`)}>
                  <span className="flex-1 text-xs text-muted-foreground">{t('manageSprints')}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Epic chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setEpicSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className={`h-7 min-h-0 min-w-0 gap-1 rounded-md border px-2 text-xs font-medium ${
                    selectedEpicId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedEpicId ? (epics.find((e) => e.id === selectedEpicId)?.title ?? t('allEpics')) : t('allEpics')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-56">
              <div className="p-1">
                <Input
                  autoFocus
                  value={epicSearch}
                  onChange={(e) => setEpicSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t('searchEpics')}
                  className="h-7 text-xs"
                />
              </div>
              <DropdownMenuSeparator />
              <div className="focus-inset max-h-[50vh] overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => updateFilter('epic_id', '')}>
                    <span className="flex-1">{t('allEpics')}</span>
                    {!selectedEpicId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                  {(() => {
                    const filtered = epics.filter((e) => e.title.toLowerCase().includes(epicSearch.toLowerCase()));
                    if (filtered.length === 0) {
                      return <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('noResults')}</div>;
                    }
                    return filtered.map((e) => (
                      <DropdownMenuItem key={e.id} onClick={() => updateFilter('epic_id', e.id)}>
                        <span className="flex-1 truncate">{e.title}</span>
                        {e.id === selectedEpicId && <Check className="size-3.5 text-primary" />}
                      </DropdownMenuItem>
                    ));
                  })()}
                </DropdownMenuGroup>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => router.push(`/${wsSlug}/${projSlug}/goals`)}>
                  <span className="flex-1 text-xs text-muted-foreground">{t('manageEpics')}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assignee chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setAssigneeSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className={`h-7 min-h-0 min-w-0 gap-1 rounded-md border px-2 text-xs font-medium ${
                    selectedAssigneeId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedAssigneeId ? (members.find((m) => m.id === selectedAssigneeId)?.name ?? t('allAssignees')) : t('allAssignees')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-56">
              <div className="p-1">
                <Input
                  autoFocus
                  value={assigneeSearch}
                  onChange={(e) => setAssigneeSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t('searchAssignees')}
                  className="h-7 text-xs"
                />
              </div>
              <DropdownMenuSeparator />
              <div className="focus-inset max-h-[50vh] overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => updateFilter('assignee_id', '')}>
                    <span className="flex-1">{t('allAssignees')}</span>
                    {!selectedAssigneeId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {(() => {
                  const q = assigneeSearch.toLowerCase();
                  const humans = members.filter((m) => m.type !== 'agent' && m.name.toLowerCase().includes(q));
                  const agents = members.filter((m) => m.type === 'agent' && m.name.toLowerCase().includes(q));
                  const hasResults = humans.length > 0 || agents.length > 0;
                  if (!hasResults) {
                    return <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('noResults')}</div>;
                  }
                  return (
                    <>
                      {humans.length > 0 && (
                        <DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">{t('filterMembers')}</DropdownMenuLabel>
                          {humans.map((m) => (
                            <DropdownMenuItem key={m.id} onClick={() => updateFilter('assignee_id', m.id)}>
                              <span className="flex-1 truncate">{m.name}</span>
                              {m.id === selectedAssigneeId && <Check className="size-3.5 text-primary" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      )}
                      {agents.length > 0 && (
                        <DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">{t('filterAgents')}</DropdownMenuLabel>
                          {agents.map((m) => (
                            <DropdownMenuItem key={m.id} onClick={() => updateFilter('assignee_id', m.id)}>
                              <span className="flex-1 truncate">{m.name}</span>
                              {m.id === selectedAssigneeId && <Check className="size-3.5 text-primary" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      )}
                    </>
                  );
                })()}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Label chip filter */}
          {orgLabels.length > 0 && (
            <DropdownMenu onOpenChange={(open) => { if (!open) setLabelSearch(''); }}>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className={`h-7 min-h-0 min-w-0 gap-1 rounded-md border px-2 text-xs font-medium ${
                      selectedLabelIds.length > 0
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                    }`}
                  >
                    <span className="max-w-[80px] truncate">
                      {selectedLabelIds.length > 0 ? t('labelsActive', { count: selectedLabelIds.length }) : t('allLabels')}
                    </span>
                    <ChevronDown className="size-3 shrink-0" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                <div className="p-1">
                  <Input
                    autoFocus
                    value={labelSearch}
                    onChange={(e) => setLabelSearch(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={t('searchLabels')}
                    className="h-7 text-xs"
                  />
                </div>
                <DropdownMenuSeparator />
                <div className="focus-inset max-h-[50vh] overflow-y-auto">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setSelectedLabelIds([])}>
                      <span className="flex-1">{t('allLabels')}</span>
                      {selectedLabelIds.length === 0 && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                    {orgLabels
                      .filter((l) => l.name.toLowerCase().includes(labelSearch.toLowerCase()))
                      .map((label) => (
                        <DropdownMenuItem
                          key={label.id}
                          onClick={() => setSelectedLabelIds((prev) =>
                            prev.includes(label.id) ? prev.filter((id) => id !== label.id) : [...prev, label.id]
                          )}
                        >
                          <span className="flex items-center gap-1.5 flex-1 truncate">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? '#8A8F98' }} />
                            {label.name}
                          </span>
                          {selectedLabelIds.includes(label.id) && <Check className="size-3.5 text-primary" />}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuGroup>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* story #2187 — is_excluded 카드가 조용히 사라지면 "삭제 대상" 카드의 존재 자체를
              아무도 모르게 된다(만든 쪽도 못 치우는데 아무도 안 보면 영영 안 놓인다) — 그래서
              숨긴 수를 항상 보이는 어포던스로 남긴다. */}
          {excludedCount > 0 && (
            <span
              title={t('excludedCountTitle')}
              className="ml-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground"
            >
              {t('excludedCountBadge', { count: excludedCount })}
            </span>
          )}
        </div>

        {/* Right: search + view toggle */}
        <div className="flex items-center gap-1">
          {/* Search toggle */}
          {showSearch ? (
            <Input
              type="search"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => { if (!searchQuery) setShowSearch(false); }}
              placeholder={t('searchPlaceholder')}
              className="h-7 w-36 text-xs"
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              title={t('searchPlaceholder')}
              onClick={() => setShowSearch(true)}
              className={`size-7 min-h-0 min-w-0 rounded-md ${
                searchQuery ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Search className="size-3.5" />
            </Button>
          )}

          {/* Board/List toggle */}
          <div className="flex items-center overflow-hidden rounded-md border border-border/60">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setViewMode('board')}
              title="Board view"
              className={`size-7 min-h-0 min-w-0 rounded-none ${
                viewMode === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-muted-foreground'
              }`}
            >
              <LayoutGrid className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setViewMode('list')}
              title="List view"
              className={`size-7 min-h-0 min-w-0 rounded-none ${
                viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-muted-foreground'
              }`}
            >
              <LayoutList className="size-3.5" />
            </Button>
          </div>

          {/* story #2933 H4(P0-H, 유나 판정 2026-08-22) — 5-status/6단계 신뢰축 컬럼 축 토글.
              애초 board/list 아이콘-토글 스타일(pill+bg-muted)을 그대로 이었었으나, 유나가
              PR#3358(I3) 위계 규율을 재확인 — 「프레임 레벨 토글=WorkspaceFrameTabs underline이
              정본·pill=flow 내부 뷰 탭 전용」. 이 토글은 아이콘 버튼 한 쌍(board/list)과 달리
              보드가 렌더하는 «컬럼 체계 자체»를 바꾸는 프레임급 전환이라 pill이 아니라
              workspace-frame-tabs.tsx와 동일한 underline 패턴(border-b-2+text-sm font-semibold,
              active=border-primary/text-foreground)을 직접 재사용한다(별도 컴포넌트 추출 없이
              — 이 자리 2탭뿐이라 workspace-frame-tabs.tsx의 라우팅 전용 구조를 억지로 씌우기보다
              그 시각 어휘만 인라인 차용, 신규 발명 아님). list 뷰에선 숨김(trust axis는 board
              렌더 전용, 이번 슬라이스 스코프). */}
          {viewMode === 'board' && (
            <div className="flex items-center gap-3 border-b border-border/60" role="tablist" aria-label={t('trustAxisView')}>
              <Button
                type="button"
                variant="ghost"
                role="tab"
                aria-selected={axisMode === 'status'}
                onClick={() => handleSetAxisMode('status')}
                className={`h-auto min-h-0 min-w-0 -mb-px whitespace-nowrap rounded-none border-x-0 border-t-0 border-b-2 px-0.5 pb-1.5 text-[11px] font-semibold ${
                  axisMode === 'status' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('trustClassicView')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                role="tab"
                aria-selected={axisMode === 'trust'}
                onClick={() => handleSetAxisMode('trust')}
                className={`h-auto min-h-0 min-w-0 -mb-px whitespace-nowrap rounded-none border-x-0 border-t-0 border-b-2 px-0.5 pb-1.5 text-[11px] font-semibold ${
                  axisMode === 'trust' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('trustAxisView')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {stories.length === 0 ? (
          // story bb78f14b(doc resource-view-firsttouch-identity-pattern §4 "보드" 행 — ⚠️과함
          // 주의 명시): 다른 4뷰(5요소)와 달리 여기는 3요소로 축소(아이콘+headline+CTA, explainer
          // 1문장) — 보드 자체가 이미 레인 시각이라 별도 visual/AI hint는 중복·클러터.
          // stories(unfiltered 원본)로 진짜 빈 프로젝트만 판정 — 필터/검색 결과 0건은 여기 안 타고
          // 기존 per-column "스토리가 없습니다" 그대로(에픽 PR#2209에서 배운 필터빈 vs 진짜빈 구분).
          // ⚠️컬럼 그리드를 대체하지 않고 그 위 배너로만 — CTA가 여는 인라인 컴포저
          // (autoComposeSignal)가 컬럼 내부 상태라, 컬럼 자체가 마운트돼 있어야 CTA 클릭이
          // 실제로 컴포저를 연다(대체했다면 신호를 받을 컬럼이 없어 무반응했을 것).
          //
          // story #2949(본편, PR#3378의 축 전환 브리지 대체) — 인라인 컴포저가 이제
          // KanbanTrustColumn(settable 4컬럼)에도 있어, 축 전환 없이 **현재 보이는 축의
          // settable 첫 컬럼**(trust=queued/status=backlog)이 바로 컴포저를 연다. #3378의
          // 임시 브리지(클릭 시 클래식으로 강제 전환)는 신호를 받을 컬럼이 없을 때만 필요했던
          // 처방이라 여기서 제거 — 축 전환 자체가 없으니 유나 #3378 design 판정이 지적한
          // "전환 시각 큐 부재"도 함께 소멸(전환이 안 일어나므로 큐가 지킬 대상이 없음).
          <div className="shrink-0 border-b border-border/60 px-6 py-4">
            <EmptyState
              icon={<Workflow className="size-8" />}
              title={t('boardEmptyTitle')}
              description={t('boardEmptyDescription')}
              action={
                <Button size="sm" onClick={() => setAutoComposeNonce((n) => n + 1)}>
                  <Plus className="size-3.5" />
                  {t('boardEmptyCta')}
                </Button>
              }
              className="bg-transparent px-0 py-0"
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === 'list' ? (
          <div className="focus-inset h-full overflow-y-auto">
            <KanbanListView
              stories={filteredStories}
              epicMap={epicMap}
              memberMap={memberMap}
              onStoryClick={handleStoryClick}
              onChangeStatus={handleChangeStatus}
              executionMap={executionMap}
              blockedByMap={blockedByMap}
              storyLabelsMap={storyLabelsMap}
              storyGatesMap={storyGatesMap}
              storyLineMap={storyLineMap}
              projectId={projectId}
              getStatusLabel={domainLabels.statusLabel}
            />
          </div>
        ) : axisMode === 'trust' ? (
          // story #2933 H4(P0-H) — 6단계 신뢰축+완료 7컬럼. handleTrustDragEnd가 파생 3컬럼
          // (needs_input/verified/merge_ready)으로의 드롭을 resolveTrustColumnId 단계에서
          // 이미 null 처리해 무효화하므로, 그 카드들의 useSortable도 locked=true로 애초에
          // 드래그 시작 자체를 막는다(이중 방어 — dnd-kit listeners 부재+drop 타깃 무효 둘 다).
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleTrustDragEnd}
          >
            <div className="flex h-full gap-3 overflow-x-auto px-3 py-3">
              {TRUST_COLUMNS.map((col) => {
                const colStories = storiesByTrustColumn(col.id);
                return (
                  <KanbanTrustColumn
                    key={col.id}
                    id={col.id}
                    label={t(col.i18nKey)}
                    locked={col.locked}
                    stories={colStories}
                    epicMap={epicMap}
                    memberMap={memberMap}
                    onStoryClick={handleStoryClick}
                    onEditStory={handleEditStory}
                    onChangeStatus={handleChangeStatus}
                    onDeleteStory={handleDeleteStory}
                    projectId={projectId}
                    onKickoffStory={handleKickoff}
                    executionMap={executionMap}
                    blockedByMap={blockedByMap}
                    storyLabelsMap={storyLabelsMap}
                    storyGatesMap={storyGatesMap}
                    storyLineMap={storyLineMap}
                    isDragging={activeId != null}
                    onCreateStory={handleCreateStoryTrust}
                    autoComposeSignal={col.id === 'queued' ? autoComposeNonce : 0}
                    getStatusLabel={domainLabels.statusLabel}
                  />
                );
              })}
            </div>
            <DragOverlayCompat adjustScale={false} className="cursor-grabbing">
              {activeStory && (
                <div className="rotate-3 scale-105">
                  <StoryCard
                    story={activeStory}
                    epicName={activeStory.epic_id ? epicMap[activeStory.epic_id] : undefined}
                    assignee={activeStory.assignee_id ? memberMap[activeStory.assignee_id] : undefined}
                    assignees={(activeStory.assignee_ids ?? []).flatMap((id) => memberMap[id] ? [memberMap[id]] : [])}
                    onClick={() => {}}
                    lineStatus={storyLineMap[activeStory.id]}
                    verifiedBy={activeStory.human_verified_by ? memberMap[activeStory.human_verified_by] : undefined}
                    getStatusLabel={domainLabels.statusLabel}
                  />
                </div>
              )}
            </DragOverlayCompat>
          </DndContext>
        ) : (
          <DndContext
            sensors={sensors}
            // closestCenter: 기본 rectIntersection은 모바일 narrow 가로스크롤 레이아웃에서 dragged rect가
            // 다중 컬럼에 걸쳐 over를 source로 오해소 → cross-column 이동 실패(story 1f81bc74 repro 확정).
            // center 기반은 멀티컨테이너 over 정확 해소·데스크탑 무회귀. 앱 내 DnD 충돌해소 primitive를
            // doc-tree.tsx와 closestCenter로 통일(디자인시스템 일관성).
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex h-full gap-3 overflow-x-auto px-3 py-3">
              {COLUMNS.map((col) => {
                const colStories = storiesByColumn(col.id);
                const wipState = wipLimits[col.id] ?? { limit: null, editing: false, draft: '' };
                const isExceeded = wipState.limit !== null && colStories.length > wipState.limit;
                return (
                  <KanbanColumn
                    key={col.id}
                    id={col.id}
                    label={domainLabels.statusLabel(col.id) ?? t(col.i18nKey)}
                    stories={colStories}
                    epicMap={epicMap}
                    memberMap={memberMap}
                    dragStatus={dragStatus}
                    onStoryClick={handleStoryClick}
                    onEditStory={handleEditStory}
                    onChangeStatus={handleChangeStatus}
                    onAssignStory={handleAssignStory}
                    onDeleteStory={handleDeleteStory}
                    projectId={projectId}
                    onKickoffStory={handleKickoff}
                    wipLimit={wipState.limit}
                    wipExceeded={isExceeded}
                    wipEditing={wipState.editing}
                    wipDraft={wipState.draft}
                    onWipLimitEdit={() => handleWipLimitEdit(col.id)}
                    onWipLimitSave={() => handleWipLimitSave(col.id)}
                    onWipLimitRemove={() => handleWipLimitRemove(col.id)}
                    onWipDraftChange={(v) => handleWipLimitDraftChange(col.id, v)}
                    onCreateStory={handleCreateStory}
                    executionMap={executionMap}
                    blockedByMap={blockedByMap}
                    storyLabelsMap={storyLabelsMap}
                    storyGatesMap={storyGatesMap}
                    storyLineMap={storyLineMap}
                    totalCount={filterActive ? colStories.length : columnTotals[col.id]}
                    hasMore={clientFilterActive ? false : !!columnCursors[col.id]}
                    loadingMore={loadingMoreColumns[col.id] ?? false}
                    onLoadMore={() => handleLoadMore(col.id)}
                    collapsed={col.id === 'done' ? doneCollapsed : undefined}
                    onToggleCollapse={col.id === 'done' ? handleToggleDoneCollapse : undefined}
                    autoComposeSignal={col.id === 'backlog' ? autoComposeNonce : 0}
                    getStatusLabel={domainLabels.statusLabel}
                  />
                );
              })}
            </div>
            <DragOverlayCompat adjustScale={false} className="cursor-grabbing">
              {activeStory && (
                <div className="rotate-3 scale-105">
                  <StoryCard
                    story={activeStory}
                    epicName={activeStory.epic_id ? epicMap[activeStory.epic_id] : undefined}
                    assignee={activeStory.assignee_id ? memberMap[activeStory.assignee_id] : undefined}
                    assignees={(activeStory.assignee_ids ?? []).flatMap((id) => memberMap[id] ? [memberMap[id]] : [])}
                    onClick={() => {}}
                    lineStatus={storyLineMap[activeStory.id]}
                    verifiedBy={activeStory.human_verified_by ? memberMap[activeStory.human_verified_by] : undefined}
                    getStatusLabel={domainLabels.statusLabel}
                  />
                </div>
              )}
            </DragOverlayCompat>
          </DndContext>
        )}
        </div>
      </div>

      {/* Load more */}
      {nextCursor || epicsNextCursor ? (
        <div className="flex flex-shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border/80 p-2">
          {nextCursor ? (
            <Button
              variant="glass"
              size="sm"
              disabled={loadingMore}
              onClick={async () => {
                if (!nextCursor) return;
                setLoadingMore(true);
                const params = new URLSearchParams();
                if (selectedSprintId) params.set('sprint_id', selectedSprintId);
                if (projectId) params.set('project_id', projectId);
                params.set('limit', '50');
                params.set('cursor', nextCursor);
                const res = await fetchWithAuth(`/api/stories?${params}`);
                if (res.ok) {
                  const json = await res.json();
                  setStories((prev) => {
                    const existingIds = new Set(prev.map((s) => s.id));
                    return [...prev, ...(json.data ?? []).filter((s: KanbanStory) => !existingIds.has(s.id))];
                  });
                  setNextCursor(json.meta?.nextCursor ?? null);
                }
                setLoadingMore(false);
              }}
            >
              {loadingMore ? t('loading') : t('loadMore')}
            </Button>
          ) : null}
          {epicsNextCursor ? (
            <Button
              variant="glass"
              size="sm"
              disabled={loadingMoreEpics}
              onClick={async () => {
                if (!epicsNextCursor) return;
                setLoadingMoreEpics(true);
                const params = new URLSearchParams();
                if (projectId) params.set('project_id', projectId);
                params.set('limit', '50');
                params.set('cursor', epicsNextCursor);
                const res = await fetchWithAuth(`/api/goals?${params.toString()}`);
                if (res.ok) {
                  const json = await res.json();
                  setEpics((prev) => [...prev, ...(json.data ?? [])]);
                  setEpicsNextCursor(json.meta?.nextCursor ?? null);
                }
                setLoadingMoreEpics(false);
              }}
            >
              {loadingMoreEpics ? t('loading') : t('loadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {selectedStory && (
        <StoryDetailPanel
          story={selectedStory}
          tasks={storyTasks}
          memberMap={memberMap}
          members={members}
          nextTasksCursor={storyTasksNextCursor}
          loadingMoreTasks={loadingMoreStoryTasks}
          onLoadMoreTasks={async () => {
            if (!selectedStory || !storyTasksNextCursor) return;
            setLoadingMoreStoryTasks(true);
            const res = await fetch(`/api/tasks?story_id=${selectedStory.id}&limit=20&cursor=${encodeURIComponent(storyTasksNextCursor)}`);
            if (res.ok) {
              const json = await res.json();
              setStoryTasks((prev) => {
                const existingIds = new Set(prev.map((t) => t.id));
                return [...prev, ...(json.data ?? []).filter((t: Task) => !existingIds.has(t.id))];
              });
              setStoryTasksNextCursor(json.meta?.nextCursor ?? null);
            }
            setLoadingMoreStoryTasks(false);
          }}
          onClose={handleCloseStory}
          onStoryUpdate={(updated) => {
            // StoryDetailPanel은 onChangeStatus를 받지 않으므로 드로어 내 status 전이는
            // 이 콜백이 유일한 경로 — status가 실제로 바뀐 경우에만 카운트 lockstep 조정.
            const prevStory = stories.find((s) => s.id === updated.id);
            setSelectedStory(updated);
            setStories((prev) => prev.map((s) => s.id === updated.id ? { ...s, ...updated } : s));
            if (prevStory && prevStory.status !== updated.status) {
              adjustColumnTotal(prevStory.status, -1);
              adjustColumnTotal(updated.status, +1);
            }
          }}
          onDeleteSuccess={(id) => {
            const story = stories.find((s) => s.id === id);
            setStories((prev) => prev.filter((s) => s.id !== id));
            if (story) adjustColumnTotal(story.status, -1);
            setSelectedStory(null);
          }}
          storyMap={Object.fromEntries(stories.map((s) => [s.id, { title: s.title, status: s.status }]))}
          epicMap={epicMap}
          sprintMap={Object.fromEntries(sprints.map((s) => [s.id, s.title]))}
          projectId={projectId}
          onNavigate={(storyId) => {
            const s = stories.find((x) => x.id === storyId);
            if (s) void handleStoryClick(s);
          }}
        />
      )}
    </div>
  );
}
