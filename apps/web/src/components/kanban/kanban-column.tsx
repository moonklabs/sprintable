'use client';

import type { ComponentType } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { StoryCard } from './story-card';
import type { KanbanStory, KanbanMember } from './types';
import { VALID_TRANSITIONS } from './types';
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
  memberMap: Record<string, KanbanMember>;
  dragStatus?: string | null;
  onStoryClick: (story: KanbanStory) => void;
  onEditStory?: (storyId: string) => void;
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onAssignStory?: (storyId: string) => void;
  onDeleteStory?: (storyId: string) => void;
}

export function KanbanColumn({ id, label, stories, epicMap, memberMap, dragStatus, onStoryClick, onEditStory, onChangeStatus, onAssignStory, onDeleteStory }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const t = useTranslations('board');

  const isDragging = dragStatus != null;
  const isValidTarget = isDragging && (VALID_TRANSITIONS[dragStatus] ?? []).includes(id);
  const isInvalidTarget = isDragging && !isValidTarget && dragStatus !== id;

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[320px] w-full flex-col rounded-lg border p-3 transition md:w-[320px] md:min-w-[280px] ${
        isOver && isValidTarget
          ? 'border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(var(--primary),0.2)]'
          : isValidTarget
          ? 'border-emerald-400/25 bg-emerald-400/5'
          : isInvalidTarget
          ? 'border-border/50 bg-muted/30 opacity-45'
          : 'border-border bg-background shadow-sm'
      }`}
    >
      {isDragging && isValidTarget && (
        <div className="mb-2 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-2 py-1 text-center text-[10px] font-medium uppercase tracking-widest text-emerald-400/70">
          {t('validDrop')}
        </div>
      )}
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <Badge variant="secondary" className="font-mono text-xs">{stories.length}</Badge>
      </div>
      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-3">
          {stories.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">{t('noStories')}</p>
          ) : null}
          {stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              epicName={story.epic_id ? epicMap[story.epic_id] : undefined}
              assignee={story.assignee_id ? memberMap[story.assignee_id] : undefined}
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
