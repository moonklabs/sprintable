'use client';

import type { ComponentType } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { StoryCard } from './story-card';
import type { KanbanStory } from './types';
import { Badge } from '@/components/ui/badge';


type SortableContextCompatProps = {
  children?: React.ReactNode;
  items: readonly unknown[];
  strategy: unknown;
  disabled?: boolean;
};
const SortableContextCompat = SortableContext as unknown as ComponentType<SortableContextCompatProps>;

interface KanbanColumnProps {
  id: string;
  label: string;
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, string>;
  onStoryClick: (story: KanbanStory) => void;
  onEditStory?: (storyId: string) => void;
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onAssignStory?: (storyId: string) => void;
  onDeleteStory?: (storyId: string) => void;
}

export function KanbanColumn({ id, label, stories, epicMap, memberMap, onStoryClick, onEditStory, onChangeStatus, onAssignStory, onDeleteStory }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const t = useTranslations('board');

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[320px] w-full min-w-[280px] flex-col rounded-3xl border p-4 transition md:w-[320px] ${isOver
        ? 'border-[color:var(--operator-primary)]/30 bg-[color:var(--operator-primary)]/10 shadow-[0_0_0_1px_rgba(182,196,255,0.16)]'
        : 'border-white/8 bg-[color:var(--operator-surface-soft)]/55'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{label}</h3>
        <Badge variant="info">{stories.length}</Badge>
      </div>
      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-3">
          {stories.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 px-3 py-8 text-center text-xs text-[color:var(--operator-muted)]">{t('noStories')}</p>
          ) : null}
          {stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              epicName={story.epic_id ? epicMap[story.epic_id] : undefined}
              assigneeName={story.assignee_id ? memberMap[story.assignee_id] : undefined}
              onClick={() => onStoryClick(story)}
              onEdit={onEditStory}
              onChangeStatus={onChangeStatus}
              onAssign={onAssignStory}
              onDelete={onDeleteStory}
            />
          ))}
        </div>
      </SortableContextCompat>
    </div>
  );
}
