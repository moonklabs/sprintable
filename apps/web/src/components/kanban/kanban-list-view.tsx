'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { COLUMNS, VALID_TRANSITIONS, type KanbanStory } from './types';

const PRIORITY_BADGE: Record<string, 'default' | 'info' | 'success' | 'destructive' | 'outline'> = {
  critical: 'destructive',
  high: 'outline',
  medium: 'info',
  low: 'default',
};

interface KanbanListViewProps {
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, string>;
  onStoryClick: (story: KanbanStory) => void;
  onChangeStatus: (storyId: string, newStatus: string) => Promise<void>;
}

interface ListStoryRowProps {
  story: KanbanStory;
  epicMap: Record<string, string>;
  memberMap: Record<string, string>;
  onStoryClick: (story: KanbanStory) => void;
  onChangeStatus: (storyId: string, newStatus: string) => Promise<void>;
}

function ListStoryRow({ story, epicMap, memberMap, onStoryClick, onChangeStatus }: ListStoryRowProps) {
  const t = useTranslations('board');
  const [statusOpen, setStatusOpen] = useState(false);
  const validNext = VALID_TRANSITIONS[story.status] ?? [];

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      setStatusOpen(false);
      await onChangeStatus(story.id, newStatus);
    },
    [story.id, onChangeStatus],
  );

  const currentColumn = COLUMNS.find((c) => c.id === story.status);

  return (
    <div className="relative flex items-center gap-3 rounded-2xl border border-white/6 bg-[color:var(--operator-surface-soft)] px-4 py-3 transition-all hover:bg-white/6">
      <button
        className="min-h-[44px] flex-1 text-left"
        onClick={() => onStoryClick(story)}
      >
        <div className="flex flex-wrap items-center gap-2">
          {story.epic_id && epicMap[story.epic_id] && (
            <Badge variant="info" className="text-[10px]">{epicMap[story.epic_id]}</Badge>
          )}
          {story.priority && (
            <Badge variant={PRIORITY_BADGE[story.priority] ?? 'default'} className="text-[10px] capitalize">{story.priority as string}</Badge>
          )}
          {story.story_points != null && (
            <span className="text-[10px] text-[color:var(--operator-muted)]">{t('storyPointsBadge', { count: story.story_points })}</span>
          )}
        </div>
        <p className="mt-1 text-sm font-medium text-[color:var(--operator-foreground)] line-clamp-2">{story.title}</p>
        {story.assignee_id && memberMap[story.assignee_id] && (
          <p className="mt-1 text-xs text-[color:var(--operator-muted)]">{memberMap[story.assignee_id]}</p>
        )}
      </button>

      <div className="relative shrink-0">
        <button
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-white/10 bg-white/5 px-2 text-xs text-[color:var(--operator-muted)] transition hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            setStatusOpen((prev) => !prev);
          }}
        >
          <span className="max-w-[80px] truncate">{currentColumn ? t(currentColumn.i18nKey) : story.status}</span>
          <ChevronDown className="ml-1 size-3 shrink-0" />
        </button>

        {statusOpen && validNext.length > 0 && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-xl border border-white/10 bg-[color:var(--operator-panel)] p-1 shadow-lg">
            {validNext.map((nextStatus) => {
              const col = COLUMNS.find((c) => c.id === nextStatus);
              if (!col) return null;
              return (
                <button
                  key={nextStatus}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-[color:var(--operator-foreground)] hover:bg-white/8"
                  onClick={() => void handleStatusChange(nextStatus)}
                >
                  {t(col.i18nKey)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface StatusGroupProps {
  columnId: string;
  label: string;
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, string>;
  onStoryClick: (story: KanbanStory) => void;
  onChangeStatus: (storyId: string, newStatus: string) => Promise<void>;
}

function StatusGroup({ columnId, label, stories, epicMap, memberMap, onStoryClick, onChangeStatus }: StatusGroupProps) {
  const [expanded, setExpanded] = useState(columnId !== 'done');

  return (
    <div>
      <button
        className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-sm font-semibold text-[color:var(--operator-foreground)] hover:bg-white/5"
        onClick={() => setExpanded((p) => !p)}
      >
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span>{label}</span>
        <span className="ml-auto rounded-full bg-white/8 px-2 py-0.5 text-xs text-[color:var(--operator-muted)]">{stories.length}</span>
      </button>

      {expanded && (
        <div className={cn('mt-1 space-y-2 pl-2', stories.length === 0 && 'pb-2')}>
          {stories.length === 0 ? (
            <p className="px-3 text-xs text-[color:var(--operator-muted)]">—</p>
          ) : (
            stories.map((story) => (
              <ListStoryRow
                key={story.id}
                story={story}
                epicMap={epicMap}
                memberMap={memberMap}
                onStoryClick={onStoryClick}
                onChangeStatus={onChangeStatus}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function KanbanListView({ stories, epicMap, memberMap, onStoryClick, onChangeStatus }: KanbanListViewProps) {
  const t = useTranslations('board');

  return (
    <div className="space-y-2">
      {COLUMNS.map((col) => {
        const colStories = stories.filter((s) => s.status === col.id);
        return (
          <StatusGroup
            key={col.id}
            columnId={col.id}
            label={t(col.i18nKey)}
            stories={colStories}
            epicMap={epicMap}
            memberMap={memberMap}
            onStoryClick={onStoryClick}
            onChangeStatus={onChangeStatus}
          />
        );
      })}
    </div>
  );
}
