'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import type { KanbanStory } from './types';
import { Badge } from '@/components/ui/badge';
import { ChevronRight } from 'lucide-react';

const EPIC_COLORS = [
  'info',
  'success',
  'secondary',
  'outline',
  'info',
] as const;

function getEpicColor(epicId: string): 'info' | 'success' | 'secondary' | 'outline' {
  const hash = epicId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return EPIC_COLORS[hash % EPIC_COLORS.length]!;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

interface StoryCardProps {
  story: KanbanStory;
  epicName?: string;
  assigneeName?: string;
  onClick: () => void;
  onEdit?: (storyId: string) => void;
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onAssign?: (storyId: string) => void;
  onDelete?: (storyId: string) => void;
}

export function StoryCard({ story, epicName, assigneeName, onClick, onEdit, onChangeStatus, onAssign, onDelete }: StoryCardProps) {
  const t = useTranslations('board');
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.id,
    data: { story },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Close menu on click outside
  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenuOpen(false);
        setStatusMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenuOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenuOpen(false);
        setStatusMenuOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [contextMenuOpen]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuOpen(true);
  }, []);

  const handleEdit = useCallback(() => {
    if (onEdit) {
      onEdit(story.id);
    }
    setContextMenuOpen(false);
  }, [story.id, onEdit]);

  const handleChangeStatusClick = useCallback((newStatus: string) => {
    if (onChangeStatus) {
      onChangeStatus(story.id, newStatus);
    }
    setContextMenuOpen(false);
    setStatusMenuOpen(false);
  }, [story.id, onChangeStatus]);

  const handleAssign = useCallback(() => {
    if (onAssign) {
      onAssign(story.id);
    }
    setContextMenuOpen(false);
  }, [story.id, onAssign]);

  const handleDelete = useCallback(() => {
    if (confirm(`Delete story "${story.title}"?`) && onDelete) {
      onDelete(story.id);
    }
    setContextMenuOpen(false);
  }, [story, onDelete]);

  const statuses = [
    { id: 'backlog', label: t('backlog') },
    { id: 'ready-for-dev', label: t('readyForDev') },
    { id: 'in-progress', label: t('inProgress') },
    { id: 'in-review', label: t('inReview') },
    { id: 'done', label: t('done') },
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className="group relative cursor-pointer overflow-hidden rounded-2xl border border-white/8 bg-[color:var(--operator-panel)]/78 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)] transition hover:border-[color:var(--operator-primary)]/18 hover:bg-white/8"
    >
      {epicName && story.epic_id ? (
        <Badge variant={getEpicColor(story.epic_id)} className="mb-2 max-w-full truncate">
          {epicName}
        </Badge>
      ) : null}
      <p className="line-clamp-2 text-sm font-medium text-[color:var(--operator-foreground)]">{story.title}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        {assigneeName ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/8 text-xs font-medium text-[color:var(--operator-foreground)]" title={assigneeName}>
            {getInitials(assigneeName)}
          </div>
        ) : (
          <div />
        )}
        {story.story_points != null ? (
          <Badge variant="outline">{t('storyPointsBadge', { count: story.story_points })}</Badge>
        ) : null}
      </div>

      {/* Context Menu */}
      {contextMenuOpen && (
        <div
          ref={menuRef}
          className="absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-white/10 bg-[color:var(--operator-panel)] p-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {onEdit && (
            <button
              onClick={handleEdit}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8"
            >
              {t('editStory')}
            </button>
          )}
          {onChangeStatus && (
            <div className="relative">
              <button
                onClick={() => setStatusMenuOpen(!statusMenuOpen)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8"
              >
                {t('changeStatus')}
                <ChevronRight className="size-3.5" />
              </button>
              {statusMenuOpen && (
                <div className="absolute left-full top-0 ml-1 w-48 rounded-xl border border-white/10 bg-[color:var(--operator-panel)] p-1 shadow-lg">
                  {statuses.map((status) => (
                    <button
                      key={status.id}
                      onClick={() => handleChangeStatusClick(status.id)}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8"
                    >
                      {status.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onAssign && (
            <button
              onClick={handleAssign}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8"
            >
              {t('assignMember')}
            </button>
          )}
          {onDelete && (
            <button
              onClick={handleDelete}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-400 hover:bg-rose-500/10"
            >
              {t('deleteStory')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
