'use client';

import type { ComponentType } from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, LayoutGrid, LayoutList, Search } from 'lucide-react';
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, DragOverlay, closestCenter } from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { KanbanColumn } from './kanban-column';
import { KanbanListView } from './kanban-list-view';
import { KanbanSkeleton } from './kanban-skeleton';
import { StoryDetailPanel } from './story-detail-panel';
import { StoryCard } from './story-card';
import { COLUMNS, VALID_TRANSITIONS, type KanbanStory, type KanbanSprint, type KanbanEpic, type KanbanMember, type ColumnId, type DependencyEdge, type GateItem } from './types';
import type { LabelData } from '@/components/ui/label-chip';

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

export function KanbanBoard({ projectId }: KanbanBoardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('board');
  const { toasts, addToast, dismissToast } = useToast();
  const [transitionError, setTransitionError] = useState<string | null>(null);
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
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board');
  const [sprintSearch, setSprintSearch] = useState('');
  const [epicSearch, setEpicSearch] = useState('');
  const [assigneeSearch, setAssigneeSearch] = useState('');

  const updateFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const storyId = searchParams.get('story');
    if (storyId) params.set('story', storyId);
    router.replace(`/board${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams]);

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

  const [selectedStory, setSelectedStory] = useState<KanbanStory | null>(null);
  const selectedStoryRef = useRef<KanbanStory | null>(null);
  selectedStoryRef.current = selectedStory;
  const [storyTasks, setStoryTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Desktop: mouse drag begins after an 8px move. Touch: a 250ms press-and-hold is
  // required before a drag starts, so vertical scrolling on mobile web isn't hijacked
  // by the drag sensor — the root cause of "보드 dnd 안 됨" on touch (S6 AC1).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
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
    params.set('status', status);
    params.set('limit', status === 'done' ? '10' : '20');
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/stories?${params}`);
    if (!res.ok) return { stories: [], total: 0, nextCursor: null };
    // RC: 헤더 대신 JSON body meta에서 cursor/total 읽기 (proxy 헤더 strip 방지)
    const json = await res.json() as { data?: KanbanStory[]; meta?: { nextCursor?: string | null; hasMore?: boolean; total?: number } };
    const stories = json.data ?? [];
    const nextCursor = json.meta?.nextCursor ?? null;
    const total = json.meta?.total ?? stories.length;
    return { stories, total, nextCursor };
  }, [projectId, selectedSprintId]);

  // E-POLISH (story 23ea0e1d): columnTotals는 fetchData에서 단 1회 세팅되므로
  // optimistic mutation이 setStories만 갱신하면 카운트 배지가 stale해진다.
  // 컬럼 멤버십을 바꾸는 모든 경로에서 이 헬퍼로 per-status total을 lockstep 조정한다.
  const adjustColumnTotal = useCallback((status: string, delta: number) => {
    setColumnTotals((prev) => ({ ...prev, [status]: Math.max(0, (prev[status] ?? 0) + delta) }));
  }, []);

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
        fetch(`/api/sprints${sprintParams}`),
        fetch(`/api/epics?${epicParams.toString()}`),
        fetch(`/api/members${memberParams}`),
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
          const summaryRes = await fetch(`/api/workflow-executions/story-summary?${summaryParams.toString()}`);
          if (summaryRes.ok) {
            const summaryJson = await summaryRes.json() as Record<string, { status: string; rule_name?: string | null; completed_at?: string | null }>;
            setExecutionMap(summaryJson);
          }
        } catch {
          // non-critical — skip silently
        }
      }

      try {
        const graphRes = await fetch('/api/dependencies/graph?item_type=story');
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
        const labelsRes = await fetch('/api/labels');
        if (labelsRes.ok) {
          const labelsJson = await labelsRes.json() as LabelData[];
          setOrgLabels(labelsJson);
          try {
            const ilRes = await fetch('/api/item-labels?item_type=story');
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
        const gatesRes = await fetch('/api/gates?status=pending&work_item_type=story');
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

  useEffect(() => { void fetchData(); }, [fetchData]);


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
      const res = await fetch(`/api/tasks?story_id=${story.id}&limit=20`);
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
      fetch(`/api/stories/${storyId}`)
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

    fetch(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const storyId = json?.data?.story_id as string | undefined;
        if (!storyId || selectedStoryRef.current?.id === storyId) return;
        const story = stories.find((s) => s.id === storyId);
        if (story) {
          void handleStoryClick(story, { replace: true });
        } else {
          fetch(`/api/stories/${storyId}`)
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

  const filteredStories = stories.filter((s) => {
    if (selectedEpicId && s.epic_id !== selectedEpicId) return false;
    if (selectedAssigneeId && s.assignee_id !== selectedAssigneeId) return false;
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

    // 다른 컬럼으로 이동 시 유효성 검사
    if (!isSameColumn) {
      const validNext = VALID_TRANSITIONS[story.status] ?? [];
      if (!validNext.includes(newStatus)) {
        setTransitionError(t('invalidTransition'));
        setTimeout(() => setTransitionError(null), 4000);
        return;
      }
    }

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
        // 롤백 (카운트도 원복)
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
        );
        adjustColumnTotal(newStatus, -1);
        adjustColumnTotal(story.status, +1);
        const errJson = await res.json().catch(() => null);
        const code = errJson?.error?.code;
        if (code === 'INVALID_TRANSITION') {
          setTransitionError(t('invalidTransition'));
          setTimeout(() => setTransitionError(null), 4000);
        } else if (code === 'FORBIDDEN') {
          setTransitionError(t('transitionDenied'));
          setTimeout(() => setTransitionError(null), 4000);
        }
        return;
      }
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
        // Rollback (카운트도 원복)
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
        );
        adjustColumnTotal(newStatus, -1);
        adjustColumnTotal(story.status, +1);
        const errJson = await res.json().catch(() => null);
        const code = errJson?.error?.code;
        if (code === 'INVALID_TRANSITION') {
          setTransitionError(t('invalidTransition'));
          setTimeout(() => setTransitionError(null), 4000);
        } else if (code === 'FORBIDDEN') {
          setTransitionError(t('transitionDenied'));
          setTimeout(() => setTransitionError(null), 4000);
        }
      }
    } catch {
      // Rollback (카운트도 원복)
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
      );
      adjustColumnTotal(newStatus, -1);
      adjustColumnTotal(story.status, +1);
    }
  }, [stories, t, adjustColumnTotal]);

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
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? '스토리 삭제에 실패했습니다.' });
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
        setTransitionError(t('createStoryFailed'));
        return;
      }
      const json = await res.json();
      const created = json.data as KanbanStory;
      setStories((prev) => [...prev, created]);
      // 카드 렌더 컬럼(created.status)과 카운트를 동일 source로 정합 — BE가 status를 정규화해도 무어긋남
      adjustColumnTotal(created.status, +1);
    } catch {
      setTransitionError(t('createStoryFailed'));
    }
  }, [projectId, selectedSprintId, selectedEpicId, t, adjustColumnTotal]);

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
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-md">
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
            <button
              key={id || 'all'}
              type="button"
              onClick={() => setAssigneeTypeFilter(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                assigneeTypeFilter === id
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}

          <div className="mx-1 h-4 w-px bg-border/60" />

          {/* Sprint chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setSprintSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors ${
                    selectedSprintId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedSprintId ? (sprints.find((s) => s.id === selectedSprintId)?.title ?? t('allSprints')) : t('allSprints')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
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
              <div className="max-h-[50vh] overflow-y-auto">
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
                <DropdownMenuItem onClick={() => router.push('/sprints')}>
                  <span className="flex-1 text-xs text-muted-foreground">{t('manageSprints')}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Epic chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setEpicSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors ${
                    selectedEpicId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedEpicId ? (epics.find((e) => e.id === selectedEpicId)?.title ?? t('allEpics')) : t('allEpics')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
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
              <div className="max-h-[50vh] overflow-y-auto">
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
                <DropdownMenuItem onClick={() => router.push('/epics')}>
                  <span className="flex-1 text-xs text-muted-foreground">{t('manageEpics')}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assignee chip */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setAssigneeSearch(''); }}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors ${
                    selectedAssigneeId
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  <span className="max-w-[80px] truncate">
                    {selectedAssigneeId ? (members.find((m) => m.id === selectedAssigneeId)?.name ?? t('allAssignees')) : t('allAssignees')}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
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
              <div className="max-h-[50vh] overflow-y-auto">
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
                  <button
                    type="button"
                    className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors ${
                      selectedLabelIds.length > 0
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
                    }`}
                  >
                    <span className="max-w-[80px] truncate">
                      {selectedLabelIds.length > 0 ? t('labelsActive', { count: selectedLabelIds.length }) : t('allLabels')}
                    </span>
                    <ChevronDown className="size-3 shrink-0" />
                  </button>
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
                <div className="max-h-[50vh] overflow-y-auto">
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
            <button
              type="button"
              title={t('searchPlaceholder')}
              onClick={() => setShowSearch(true)}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                searchQuery ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Search className="size-3.5" />
            </button>
          )}

          {/* Board/List toggle */}
          <div className="flex items-center overflow-hidden rounded-md border border-border/60">
            <button
              type="button"
              onClick={() => setViewMode('board')}
              title="Board view"
              className={`flex h-7 w-7 items-center justify-center transition-colors ${
                viewMode === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              <LayoutGrid className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              title="List view"
              className={`flex h-7 w-7 items-center justify-center transition-colors ${
                viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              <LayoutList className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === 'list' ? (
          <div className="h-full overflow-y-auto">
            <KanbanListView
              stories={filteredStories}
              epicMap={epicMap}
              memberMap={memberMap}
              onStoryClick={handleStoryClick}
              onChangeStatus={handleChangeStatus}
            />
          </div>
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
                    label={t(col.i18nKey)}
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
                    totalCount={filterActive ? colStories.length : columnTotals[col.id]}
                    hasMore={filterActive ? false : !!columnCursors[col.id]}
                    loadingMore={loadingMoreColumns[col.id] ?? false}
                    onLoadMore={() => handleLoadMore(col.id)}
                    collapsed={col.id === 'done' ? doneCollapsed : undefined}
                    onToggleCollapse={col.id === 'done' ? handleToggleDoneCollapse : undefined}
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
                  />
                </div>
              )}
            </DragOverlayCompat>
          </DndContext>
        )}
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
                const res = await fetch(`/api/stories?${params}`);
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
                const res = await fetch(`/api/epics?${params.toString()}`);
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
