'use client';

import type { ComponentType } from 'react';
import { useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
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

const STATUS_COLOR: Record<string, { dot: string; tint: string }> = {
  'backlog': { dot: 'bg-muted-foreground/40', tint: 'bg-muted/40' },
  'ready-for-dev': { dot: 'bg-muted-foreground/60', tint: 'bg-muted/40' },
  'in-progress': { dot: 'bg-amber-500', tint: 'bg-amber-400/8' },
  'in-review': { dot: 'bg-emerald-500', tint: 'bg-emerald-400/8' },
  'done': { dot: 'bg-emerald-600', tint: 'bg-emerald-500/12' },
};

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
  // Inline create
  onCreateStory?: (columnId: string, title: string) => Promise<void> | void;
}

export function KanbanColumn({
  id, label, stories, epicMap, memberMap, dragStatus, onStoryClick,
  onEditStory, onChangeStatus, onAssignStory, onDeleteStory,
  wipLimit, wipExceeded, wipEditing, wipDraft,
  onWipLimitEdit, onWipLimitSave, onWipLimitRemove, onWipDraftChange,
  onCreateStory,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const t = useTranslations('board');
  const inputRef = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const startCompose = () => {
    setDraftTitle('');
    setComposing(true);
  };
  const cancelCompose = () => {
    setComposing(false);
    setDraftTitle('');
  };
  const submitCompose = async () => {
    const title = draftTitle.trim();
    if (!title || !onCreateStory || submitting) return;
    setSubmitting(true);
    try {
      await onCreateStory(id, title);
      setDraftTitle('');
      setComposing(false);
    } finally {
      setSubmitting(false);
    }
  };

  const isDragging = dragStatus != null;
  const isValidTarget = isDragging && (VALID_TRANSITIONS[dragStatus] ?? []).includes(id);
  const isInvalidTarget = isDragging && !isValidTarget && dragStatus !== id;

  const statusColor = STATUS_COLOR[id] ?? STATUS_COLOR['backlog'];
  // AC1: WIP 초과 시 빨간 강조
  const colClass = wipExceeded
    ? 'bg-destructive/5 ring-1 ring-destructive/30'
    : isOver && isValidTarget
      ? 'bg-primary/5 ring-1 ring-primary/20'
      : isValidTarget
        ? 'bg-emerald-400/5'
        : isInvalidTarget
          ? 'bg-muted/20 opacity-45'
          : statusColor.tint;

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full w-[280px] min-w-[240px] flex-col rounded-xl p-3 transition ${colClass}`}
    >
      {isDragging && isValidTarget && (
        <div className="mb-3 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-2 py-1 text-center text-[10px] font-medium uppercase tracking-widest text-emerald-400/70">
          {t('validDrop')}
        </div>
      )}

      {/* 컬럼 헤더 */}
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${statusColor.dot}`} aria-hidden="true" />
            {label}
          </h3>
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
            {onCreateStory ? (
              <button
                type="button"
                aria-label={t('addStory')}
                title={t('addStory')}
                onClick={startCompose}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            ) : null}
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

      {composing ? (
        <div className="mb-2 rounded-xl border border-primary/30 bg-background/50 p-2">
          <Input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitCompose();
              } else if (e.key === 'Escape') {
                cancelCompose();
              }
            }}
            placeholder={t('addStoryPlaceholder')}
            className="h-8 text-sm"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-7 px-2 text-xs"
              onClick={() => void submitCompose()}
              disabled={submitting || !draftTitle.trim()}
            >
              {t('addStorySubmit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={cancelCompose}
            >
              {t('addStoryCancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
          {stories.length === 0 && !composing ? (
            <div className="flex min-h-[100px] items-center justify-center px-4 text-center">
              <p className="text-xs text-muted-foreground/60">{t('noStories')}</p>
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
