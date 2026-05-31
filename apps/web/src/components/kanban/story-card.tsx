'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import type { KanbanStory, KanbanMember } from './types';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ChevronRight, Rocket, Zap, ZapOff } from 'lucide-react';
import { LabelChip } from '@/components/ui/label-chip';

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

interface WorkflowExecStatus {
  status: string;
  rule_name?: string | null;
  completed_at?: string | null;
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
  projectId?: string;
  onKickoff?: (storyId: string, result: 'triggered' | 'no_match' | 'conflict' | 'error') => void;
  lastExecution?: WorkflowExecStatus | null;
  blockedBy?: string[];
  labels?: { id: string; name: string; color: string | null }[];
  gates?: { id: string; gate_type: string; status: string }[];
}

export function StoryCard({ story, epicName, assignee, onClick, onEdit, onChangeStatus, onAssign, onDelete, projectId, onKickoff, lastExecution, blockedBy = [], labels = [], gates = [] }: StoryCardProps) {
  const t = useTranslations('board');
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleKickoff = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!projectId || triggering) return;
    setTriggering(true);
    try {
      const res = await fetch('/api/workflow/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, story_id: story.id, trigger_type_slug: 'kickoff' }),
      });
      if (res.status === 409) {
        onKickoff?.(story.id, 'conflict');
      } else if (res.ok) {
        const data = await res.json() as { status: string };
        onKickoff?.(story.id, data.status === 'triggered' ? 'triggered' : 'no_match');
      } else {
        onKickoff?.(story.id, 'error');
      }
    } catch {
      onKickoff?.(story.id, 'error');
    } finally {
      setTriggering(false);
    }
  }, [projectId, story.id, triggering, onKickoff]);

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
          ? 'bg-gradient-to-br from-accent-claim/8 to-purple-500/4 ring-1 ring-accent-claim/30 hover:ring-accent-claim/60'
          : 'bg-background shadow-sm hover:shadow-md hover:bg-background'
      }`}
    >
      {assignee?.type === 'agent' && (
        <div className="absolute inset-0 pointer-events-none rounded-lg border border-transparent bg-gradient-to-r from-accent-claim/10 to-purple-500/10 opacity-50" />
      )}
      {epicName && story.epic_id ? (
        <Badge variant={getEpicColor(story.epic_id)} className="mb-2 max-w-full">
          <span className="min-w-0 truncate leading-none">{epicName}</span>
        </Badge>
      ) : null}
      {/* Zone A meta row — dep 뱃지 + label 칩 + gate 뱃지 */}
      {(blockedBy.length > 0 && story.status !== 'done') || labels.length > 0 || gates.filter((g) => g.status === 'pending').length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {blockedBy.length > 0 && story.status !== 'done' ? (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="size-3 shrink-0" />
              <span>{t('blockedBy', { count: blockedBy.length })}</span>
            </Badge>
          ) : null}
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {gates.filter((g) => g.status === 'pending').map((gate) => (
            <Badge key={gate.id} variant="info" className="gap-1">
              <span>⏸</span>
              <span>{gate.gate_type} {t('gatePending')}</span>
            </Badge>
          ))}
        </div>
      ) : null}
      <p className="relative z-10 line-clamp-2 text-sm font-medium leading-5 text-foreground">{story.title}</p>
      <div className="relative z-10 mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {assignee ? (
            <div className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-medium ${
              assignee.type === 'agent' 
                ? 'border-accent-claim/30 bg-accent-claim/10 text-accent-claim'
                : 'border-border bg-muted text-muted-foreground'
            }`} title={assignee.name}>
              {getInitials(assignee.name)}
            </div>
          ) : (
            <div />
          )}
          {assignee?.type === 'agent' && (
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-accent-claim">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-claim opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent-claim"></span>
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
          {lastExecution ? (
            <span
              title={[
                lastExecution.rule_name ?? '워크플로우 실행됨',
                lastExecution.completed_at ? new Date(lastExecution.completed_at).toLocaleString() : '',
                lastExecution.status === 'matched' ? '✅ 규칙 매칭' : '⊘ 규칙 없음',
              ].filter(Boolean).join(' · ')}
              className="flex h-5 w-5 items-center justify-center"
            >
              {lastExecution.status === 'matched' ? (
                <Zap className="h-3 w-3 text-warning" />
              ) : (
                <ZapOff className="h-3 w-3 text-muted-foreground/40" />
              )}
            </span>
          ) : null}
          {projectId ? (
            <button
              onClick={(e) => void handleKickoff(e)}
              disabled={triggering}
              title={t('kickoff')}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:text-primary hover:bg-primary/10 disabled:opacity-40 transition"
            >
              {triggering ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              ) : (
                <Rocket className="h-3 w-3" />
              )}
            </button>
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
