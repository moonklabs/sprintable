'use client';

import type { ComponentType } from 'react';
import { useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { StoryCard } from './story-card';
import type { KanbanStory, KanbanMember } from './types';
import { VALID_TRANSITIONS } from './types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';


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
  // AC1/AC5: WIP limit
  wipLimit?: number | null;
  wipExceeded?: boolean;
  wipEditing?: boolean;
  wipDraft?: string;
  onWipLimitEdit?: () => void;
  onWipLimitSave?: () => void;
  onWipLimitRemove?: () => void;
  onWipDraftChange?: (value: string) => void;
}

export function KanbanColumn({
  id, label, stories, epicMap, memberMap, dragStatus, onStoryClick,
  onEditStory, onChangeStatus, onAssignStory, onDeleteStory,
  wipLimit, wipExceeded, wipEditing, wipDraft,
  onWipLimitEdit, onWipLimitSave, onWipLimitRemove, onWipDraftChange,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const t = useTranslations('board');
  const inputRef = useRef<HTMLInputElement>(null);

  const isDragging = dragStatus != null;
  const isValidTarget = isDragging && (VALID_TRANSITIONS[dragStatus] ?? []).includes(id);
  const isInvalidTarget = isDragging && !isValidTarget && dragStatus !== id;

  // AC1: WIP 초과 시 빨간 테두리
  const borderClass = wipExceeded
    ? 'border-destructive/70 shadow-[0_0_0_1px_rgba(var(--destructive),0.25)]'
    : isOver && isValidTarget
      ? 'border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(var(--primary),0.2)]'
      : isValidTarget
        ? 'border-emerald-400/25 bg-emerald-400/5'
        : isInvalidTarget
          ? 'border-border/50 bg-muted/30 opacity-45'
          : 'border-border/80 bg-card shadow-sm';

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[360px] w-full flex-col rounded-2xl border p-4 transition md:w-[340px] md:min-w-[300px] ${borderClass}`}
    >
      {isDragging && isValidTarget && (
        <div className="mb-3 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-2 py-1 text-center text-[10px] font-medium uppercase tracking-widest text-emerald-400/70">
          {t('validDrop')}
        </div>
      )}

      {/* 컬럼 헤더 */}
      <div className="mb-4 flex flex-col gap-2 border-b border-border/70 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{label}</h3>
          <div className="flex items-center gap-1.5">
            {/* AC1: WIP 초과 배지 */}
            {wipExceeded && (
              <Badge variant="destructive" className="rounded-full px-2 font-mono text-[10px]">
                {t('wipLimitExceeded')}
              </Badge>
            )}
            {/* AC1: WIP limit 배지 (설정된 경우) */}
            {wipLimit !== null && wipLimit !== undefined && !wipExceeded && (
              <Badge variant="secondary" className="rounded-full px-2 font-mono text-[10px] text-muted-foreground">
                {t('wipLimitLabel')}: {wipLimit}
              </Badge>
            )}
            {/* 카드 수 배지 */}
            <Badge
              variant="secondary"
              className={`rounded-full px-2.5 font-mono text-[11px] shadow-sm ${wipExceeded ? 'bg-destructive/15 text-destructive' : ''}`}
            >
              {stories.length}
            </Badge>
            {/* AC5: WIP limit 편집 버튼 */}
            <button
              type="button"
              aria-label={t('wipLimitSet')}
              title={t('wipLimitSet')}
              onClick={onWipLimitEdit}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition hover:text-foreground"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M11.013 1.427a1.75 1.75 0 012.474 2.474L4.92 12.47l-3.265.905.905-3.265 8.453-8.683z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* AC5: WIP limit 편집 UI */}
        {wipEditing && (
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              type="number"
              min={1}
              value={wipDraft ?? ''}
              onChange={(e) => onWipDraftChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onWipLimitSave?.();
                if (e.key === 'Escape') onWipLimitRemove?.();
              }}
              placeholder={t('wipLimitLabel')}
              className="h-7 w-20 text-xs"
              autoFocus
            />
            <Button size="sm" variant="default" className="h-7 px-2 text-xs" onClick={onWipLimitSave}>
              {t('wipLimitSave')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={onWipLimitRemove}>
              {t('wipLimitRemove')}
            </Button>
          </div>
        )}
      </div>

      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {stories.length === 0 ? (
            <div className="flex min-h-[124px] items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 text-center">
              <p className="text-xs font-medium text-muted-foreground">{t('noStories')}</p>
            </div>
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
