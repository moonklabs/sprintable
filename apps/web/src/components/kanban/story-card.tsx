'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import type { KanbanStory, KanbanMember } from './types';
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
  assignee?: KanbanMember;
  onClick: () => void;
  onEdit?: (storyId: string) => void;
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onAssign?: (storyId: string) => void;
  onDelete?: (storyId: string) => void;
}

export function StoryCard({ story, epicName, assignee, onClick, onEdit, onChangeStatus, onAssign, onDelete }: StoryCardProps) {
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
      className={`group relative cursor-pointer overflow-hidden rounded-lg p-3 transition ${
        assignee?.type === 'agent'
          ? 'bg-[linear-gradient(135deg,rgba(6,182,212,0.08),rgba(168,85,247,0.04))] ring-1 ring-cyan-500/30 hover:ring-cyan-400/60'
          : 'bg-background shadow-sm hover:shadow-md hover:bg-background'
      }`}
    >
      {assignee?.type === 'agent' && (
        <div className="absolute inset-0 pointer-events-none rounded-lg border border-transparent bg-gradient-to-r from-cyan-500/10 to-purple-500/10 opacity-50" />
      )}
      {epicName && story.epic_id ? (
        <Badge variant={getEpicColor(story.epic_id)} className="mb-3 max-w-full truncate">
          {epicName}
        </Badge>
      ) : null}
      <p className="relative z-10 line-clamp-2 text-sm font-medium leading-5 text-foreground">{story.title}</p>
      <div className="relative z-10 mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {assignee ? (
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-medium ${
              assignee.type === 'agent' 
                ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400' 
                : 'border-border bg-muted text-muted-foreground'
            }`} title={assignee.name}>
              {getInitials(assignee.name)}
            </div>
          ) : (
            <div />
          )}
          {assignee?.type === 'agent' && (
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-cyan-600 dark:text-cyan-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500"></span>
              </span>
              <span>&gt; Agent active</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/50">#{story.id.slice(0, 6)}</span>
          {story.story_points != null ? (
            <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0">{story.story_points}</Badge>
          ) : null}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenuOpen && (
        <div
          ref={menuRef}
          className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          onClick={(e) => e.stopPropagation()}
        >
          {onEdit && (
            <button
              onClick={handleEdit}
              className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {t('editStory')}
            </button>
          )}
          {onChangeStatus && (
            <div className="relative">
              <button
                onClick={() => setStatusMenuOpen(!statusMenuOpen)}
                className="flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
              >
                {t('changeStatus')}
                <ChevronRight className="size-3.5" />
              </button>
              {statusMenuOpen && (
                <div className="absolute left-full top-0 ml-1 w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  {statuses.map((status) => (
                    <button
                      key={status.id}
                      onClick={() => handleChangeStatusClick(status.id)}
                      className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
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
              className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {t('assignMember')}
            </button>
          )}
          {onDelete && (
            <button
              onClick={handleDelete}
              className="w-full rounded-sm px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
            >
              {t('deleteStory')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
