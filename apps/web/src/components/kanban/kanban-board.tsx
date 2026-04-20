'use client';

import type { ComponentType } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { KanbanColumn } from './kanban-column';
import { KanbanFilters } from './kanban-filters';
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

  const [selectedSprintId, setSelectedSprintId] = useState(() => searchParams.get('sprint_id') ?? '');
  const [selectedEpicId, setSelectedEpicId] = useState(() => searchParams.get('epic_id') ?? '');
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');

  // Sync epic_id to URL
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (selectedEpicId) {
      params.set('epic_id', selectedEpicId);
    } else {
      params.delete('epic_id');
    }
    const storyId = searchParams.get('story');
    if (!storyId) {
      router.replace(params.toString() ? `?${params.toString()}` : window.location.pathname, { scroll: false });
    }
  }, [selectedEpicId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedStory, setSelectedStory] = useState<KanbanStory | null>(null);
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
      epicParams.set('limit', '50');
      const memberParams = projectId ? `?project_id=${projectId}` : '';

      params.set('limit', '50');
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
      if (story && (!selectedStory || selectedStory.id !== storyId)) {
        void handleStoryClick(story);
      }
    }
  }, [searchParams, stories, selectedStory, handleStoryClick]);

  const filteredStories = stories.filter((s) => {
    if (selectedEpicId && s.epic_id !== selectedEpicId) return false;
    if (selectedAssigneeId && s.assignee_id !== selectedAssigneeId) return false;
    return true;
  });

  const storiesByColumn = (columnId: string) =>
    filteredStories.filter((s) => s.status === columnId);

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

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const storyId = String(active.id);
    const newStatus = resolveColumnId(String(over.id));
    if (!newStatus) return;

    // 같은 컬럼이면 무시
    const story = stories.find((s) => s.id === storyId);
    if (!story || story.status === newStatus) return;

    // 유효하지 않은 전이 사전 차단 — API 호출 없이 즉시 피드백
    const validNext = VALID_TRANSITIONS[story.status] ?? [];
    if (!validNext.includes(newStatus)) {
      setTransitionError(t('invalidTransition'));
      setTimeout(() => setTransitionError(null), 4000);
      return;
    }

    // 낙관적 업데이트
    setStories((prev) =>
      prev.map((s) => (s.id === storyId ? { ...s, status: newStatus } : s)),
    );

    // API 호출
    try {
      const res = await fetch('/api/stories/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
      });
      if (!res.ok) {
        // 롤백
        setStories((prev) =>
          prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
        );
        // 에러 토스트 (i18n)
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
      // 롤백
      setStories((prev) =>
        prev.map((s) => (s.id === storyId ? { ...s, status: story.status } : s)),
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

  const activeStory = activeId ? stories.find((s) => s.id === activeId) : null;
  const dragStatus = activeStory?.status ?? null;

  if (loading) return <KanbanSkeleton />;

  return (
    <div className="space-y-4">
      {transitionError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-md">
          ⚠️ {transitionError}
        </div>
      )}
      <KanbanFilters
        sprints={sprints}
        epics={epics}
        members={members}
        selectedSprintId={selectedSprintId}
        selectedEpicId={selectedEpicId}
        selectedAssigneeId={selectedAssigneeId}
        onSprintChange={setSelectedSprintId}
        onEpicChange={setSelectedEpicId}
        onAssigneeChange={setSelectedAssigneeId}
      />

      {/* Mobile list view (hidden on md+) */}
      <div className="md:hidden">
        <KanbanListView
          stories={filteredStories}
          epicMap={epicMap}
          memberMap={memberMap}
          onStoryClick={handleStoryClick}
          onChangeStatus={handleChangeStatus}
        />
      </div>

      {/* Desktop kanban (hidden below md) */}
      <div className="hidden md:block">
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex flex-row gap-4 overflow-x-auto pb-4">
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col.id}
                id={col.id}
                label={t(col.i18nKey)}
                stories={storiesByColumn(col.id)}
                epicMap={epicMap}
                memberMap={memberMap}
                dragStatus={dragStatus}
                onStoryClick={handleStoryClick}
                onEditStory={handleEditStory}
                onChangeStatus={handleChangeStatus}
                onAssignStory={handleAssignStory}
                onDeleteStory={handleDeleteStory}
              />
            ))}
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
      </div>

      {nextCursor || epicsNextCursor ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
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
