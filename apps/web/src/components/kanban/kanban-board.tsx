'use client';

import type { ComponentType } from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, LayoutGrid, LayoutList, Search, SlidersHorizontal } from 'lucide-react';
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
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
import { KanbanColumn } from './kanban-column';
import { KanbanListView } from './kanban-list-view';
import { KanbanSkeleton } from './kanban-skeleton';
import { StoryDetailPanel } from './story-detail-panel';
import { StoryCard } from './story-card';
import { COLUMNS, VALID_TRANSITIONS, type KanbanStory, type KanbanSprint, type KanbanEpic, type KanbanMember, type ColumnId } from './types';

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
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [stories, setStories] = useState<KanbanStory[]>([]);
  const [sprints, setSprints] = useState<KanbanSprint[]>([]);
  const [epics, setEpics] = useState<KanbanEpic[]>([]);
  const [members, setMembers] = useState<KanbanMember[]>([]);
  const [loading, setLoading] = useState(true);
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

  const updateFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const storyId = searchParams.get('story');
    if (storyId) params.set('story', storyId);
    router.replace(`/board${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams]);

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

  const [selectedStory, setSelectedStory] = useState<KanbanStory | null>(null);
  const selectedStoryRef = useRef<KanbanStory | null>(null);
  selectedStoryRef.current = selectedStory;
  const [storyTasks, setStoryTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const epicMap: Record<string, string> = {};
  for (const e of epics) epicMap[e.id] = e.title;
  const memberMap: Record<string, KanbanMember> = {};
  for (const m of members) memberMap[m.id] = m;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedSprintId) params.set('sprint_id', selectedSprintId);
      if (projectId) params.set('project_id', projectId);

      const sprintParams = projectId ? `?project_id=${projectId}` : '';
      const epicParams = new URLSearchParams();
      if (projectId) epicParams.set('project_id', projectId);
      epicParams.set('limit', '20');
      const memberParams = projectId ? `?project_id=${projectId}` : '';

      params.set('limit', '20');
      const [storiesRes, sprintsRes, epicsRes, membersRes] = await Promise.all([
        fetch(`/api/stories?${params}`),
        fetch(`/api/sprints${sprintParams}`),
        fetch(`/api/epics?${epicParams.toString()}`),
        fetch(`/api/team-members${memberParams}`),
      ]);

      if (storiesRes.ok) { const json = await storiesRes.json(); setStories(json.data); setNextCursor(json.meta?.nextCursor ?? null); }
      if (sprintsRes.ok) { const json = await sprintsRes.json(); setSprints(json.data); }
      if (epicsRes.ok) { const json = await epicsRes.json(); setEpics(json.data); setEpicsNextCursor(json.meta?.nextCursor ?? null); }
      if (membersRes.ok) { const json = await membersRes.json(); setMembers(json.data); }
    } finally {
      setLoading(false);
    }
  }, [selectedSprintId, projectId]);

  useEffect(() => { void fetchData(); }, [fetchData]);


  const handleStoryClick = useCallback(async (story: KanbanStory) => {
    setSelectedStory(story);
    setStoryTasksNextCursor(null);

    // URL에 스토리 ID 반영
    const params = new URLSearchParams(searchParams);
    params.set('story', story.id);
    router.replace(`?${params.toString()}`, { scroll: false });

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
    if (storyId && stories.length > 0) {
      const story = stories.find((s) => s.id === storyId);
      if (story && (!selectedStoryRef.current || selectedStoryRef.current.id !== storyId)) {
        void handleStoryClick(story);
      }
    }
  }, [searchParams, stories, handleStoryClick]);

  const filteredStories = stories.filter((s) => {
    if (selectedEpicId && s.epic_id !== selectedEpicId) return false;
    if (selectedAssigneeId && s.assignee_id !== selectedAssigneeId) return false;
    if (assigneeTypeFilter) {
      const assignee = s.assignee_id ? memberMap[s.assignee_id] : null;
      if (assigneeTypeFilter === 'agent' && assignee?.type !== 'agent') return false;
      if (assigneeTypeFilter === 'human' && assignee?.type === 'agent') return false;
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
        // 롤백
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
        );
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
      // 롤백
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status, position: story.position } : s)),
      );
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

    // API call
    try {
      const res = await fetch('/api/stories/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
      });
      if (!res.ok) {
        // Rollback
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
        );
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
      // Rollback
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
      );
    }
  }, [stories, t]);

  const handleAssignStory = useCallback(async (storyId: string) => {
    // TODO: Implement proper member selection UI
    // For now, just open the detail panel
    const story = stories.find((s) => s.id === storyId);
    if (story) {
      void handleStoryClick(story);
    }
  }, [stories, handleStoryClick]);

  const handleDeleteStory = useCallback(async (storyId: string) => {
    // Optimistic update
    setStories((prev) => prev.filter((s) => s.id !== storyId));

    try {
      const res = await fetch(`/api/stories/${storyId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        // Rollback
        await fetchData();
      }
    } catch {
      // Rollback
      await fetchData();
    }
  }, [fetchData]);

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
    } catch {
      setTransitionError(t('createStoryFailed'));
    }
  }, [projectId, selectedSprintId, selectedEpicId, t]);

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
      {transitionError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-md">
          ⚠️ {transitionError}
        </div>
      )}

      {/* Board header */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border/80 px-4">
        {/* Left: assignee type tabs */}
        <div className="flex items-center gap-0.5">
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
        </div>

        {/* Right: filter icon + view toggle */}
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

          {/* Filter dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  title={t('filterTitle')}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                    selectedSprintId || selectedEpicId || selectedAssigneeId
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <SlidersHorizontal className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('sprints')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('sprint_id', '')}>
                  <span className="flex-1">{t('allSprints')}</span>
                  {!selectedSprintId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {sprints.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => updateFilter('sprint_id', s.id)}>
                    <span className="flex-1 truncate">{s.title}</span>
                    {s.id === selectedSprintId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('epics')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('epic_id', '')}>
                  <span className="flex-1">{t('allEpics')}</span>
                  {!selectedEpicId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {epics.map((e) => (
                  <DropdownMenuItem key={e.id} onClick={() => updateFilter('epic_id', e.id)}>
                    <span className="flex-1 truncate">{e.title}</span>
                    {e.id === selectedEpicId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('assignees')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('assignee_id', '')}>
                  <span className="flex-1">{t('allAssignees')}</span>
                  {!selectedAssigneeId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {members.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => updateFilter('assignee_id', m.id)}>
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.id === selectedAssigneeId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

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
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
                    wipLimit={wipState.limit}
                    wipExceeded={isExceeded}
                    wipEditing={wipState.editing}
                    wipDraft={wipState.draft}
                    onWipLimitEdit={() => handleWipLimitEdit(col.id)}
                    onWipLimitSave={() => handleWipLimitSave(col.id)}
                    onWipLimitRemove={() => handleWipLimitRemove(col.id)}
                    onWipDraftChange={(v) => handleWipLimitDraftChange(col.id, v)}
                    onCreateStory={handleCreateStory}
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
                  setStories((prev) => [...prev, ...(json.data ?? [])]);
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
          nextTasksCursor={storyTasksNextCursor}
          loadingMoreTasks={loadingMoreStoryTasks}
          onLoadMoreTasks={async () => {
            if (!selectedStory || !storyTasksNextCursor) return;
            setLoadingMoreStoryTasks(true);
            const res = await fetch(`/api/tasks?story_id=${selectedStory.id}&limit=20&cursor=${encodeURIComponent(storyTasksNextCursor)}`);
            if (res.ok) {
              const json = await res.json();
              setStoryTasks((prev) => [...prev, ...(json.data ?? [])]);
              setStoryTasksNextCursor(json.meta?.nextCursor ?? null);
            }
            setLoadingMoreStoryTasks(false);
          }}
          onClose={handleCloseStory}
        />
      )}
    </div>
  );
}
