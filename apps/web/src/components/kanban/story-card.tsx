'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import type { KanbanStory, KanbanMember, LineStatusSummary } from './types';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ChevronRight, EyeOff, History, Pause, Rocket, Zap, ZapOff, type LucideIcon } from 'lucide-react';
import { LabelChip } from '@/components/ui/label-chip';

// E-MODERN A: 에픽 식별 dot — 기존 시맨틱 토큰만(신규 토큰/raw 팔레트 0). 신호색(warning=blocked·
// accent-claim=agent·destructive) 회피해 의미 충돌 0. 랜덤 5색 채움 배지(loud)는 퇴출.
const EPIC_DOT_CLASSES = ['bg-info', 'bg-success', 'bg-secondary', 'bg-muted-foreground'] as const;

function getEpicDotClass(epicId: string): string {
  const hash = epicId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return EPIC_DOT_CLASSES[hash % EPIC_DOT_CLASSES.length]!;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// E-DG S11 ①: workflow-line badge 5상태(LineStatusSummary + 기존 pending gate 두 소스 merge).
type LineBadgeState = 'handoff_stuck' | 'waiting_human' | 'pending_gate' | 'engine_degraded' | 'grandfathered';

// human gate 대기 step run status(BE _blocking_reason gate-대기 분기와 정합).
const WAITING_HUMAN_STATUSES = new Set(['gate_pending', 'waiting_gate', 'waiting_parallel']);

// boy-scout 절제: 카드엔 우선순위 1배지만(행동필요 > 정보성).
// handoff_stuck > waiting_human > pending gate > engine_degraded > grandfathered.
function deriveLineBadge(line: LineStatusSummary | undefined, hasPendingGate: boolean): LineBadgeState | null {
  if (line?.has_active) {
    if (line.handoff_stuck) return 'handoff_stuck';
    if (line.status && WAITING_HUMAN_STATUSES.has(line.status)) return 'waiting_human';
  }
  if (hasPendingGate) return 'pending_gate';
  if (line?.has_active) {
    if (line.engine_degraded) return 'engine_degraded';
    if (line.grandfathered) return 'grandfathered';
  }
  return null;
}

// pending_gate 는 gate_type 동반이라 렌더서 특수처리 → meta 는 신규 4상태만.
const LINE_BADGE_META: Record<
  Exclude<LineBadgeState, 'pending_gate'>,
  { variant: 'destructive' | 'warning' | 'outline'; Icon: LucideIcon; labelKey: string }
> = {
  handoff_stuck: { variant: 'destructive', Icon: AlertTriangle, labelKey: 'lineHandoffStuck' },
  waiting_human: { variant: 'warning', Icon: Pause, labelKey: 'lineWaitingHuman' },
  engine_degraded: { variant: 'outline', Icon: EyeOff, labelKey: 'lineEngineDegraded' },
  grandfathered: { variant: 'outline', Icon: History, labelKey: 'lineGrandfathered' },
};

interface WorkflowExecStatus {
  status: string;
  rule_name?: string | null;
  completed_at?: string | null;
}

interface StoryCardProps {
  story: KanbanStory;
  epicName?: string;
  assignee?: KanbanMember;
  assignees?: KanbanMember[];
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
  lineStatus?: LineStatusSummary;
}

export function StoryCard({ story, epicName, assignee, assignees, onClick, onEdit, onChangeStatus, onAssign, onDelete, projectId, onKickoff, lastExecution, blockedBy = [], labels = [], gates = [], lineStatus }: StoryCardProps) {
  const t = useTranslations('board');
  // E-BOARD S6: 복수 assignee. assignees 우선, 없으면 단일 assignee 폴백. agent 한 명이라도 있으면 agent 취급(glow).
  const assigneeList = (assignees && assignees.length > 0) ? assignees : (assignee ? [assignee] : []);
  const hasAgent = assigneeList.some((m) => m.type === 'agent');
  const tCage = useTranslations('cage');
  // S11 ①: line badge — 신규 4상태(LineStatusSummary) + 기존 pending gate merge, boy-scout 1배지.
  const hasPendingGate = gates.some((g) => g.status === 'pending');
  const lineBadge = deriveLineBadge(lineStatus, hasPendingGate);
  const lineBadgeMeta = lineBadge && lineBadge !== 'pending_gate' ? LINE_BADGE_META[lineBadge] : null;
  const pendingGateType = lineBadge === 'pending_gate' ? gates.find((g) => g.status === 'pending')?.gate_type : undefined;
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
    // Touch dnd: pan-x pan-y lets a quick swipe scroll natively in BOTH axes (aborting the
    // TouchSensor's 250ms delay) while a press-and-hold still starts a drag (dnd-kit
    // preventDefaults once active). `none` would kill scroll-on-card.
    // 0a36762d: pan-y alone (S6) preserved vertical column scroll but BLOCKED horizontal board
    // scroll — columns sit in an `overflow-x-auto` row (scrollW>clientW), so a horizontal swipe
    // starting on a card had no native scroll and got captured. pan-x pan-y restores horizontal
    // board scroll (superset of pan-y → no regression to vertical scroll or desktop drag).
    touchAction: 'pan-x pan-y' as const,
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
      title={`#${story.id.slice(0, 6)}`}
      className="group relative cursor-pointer rounded-lg border border-border bg-card p-3 transition hover:border-muted-foreground/30"
    >
      {/* E-MODERN A: 에픽 = 작은 색 dot + muted 라벨(일관 식별·랜덤 채움배지 퇴출) */}
      {epicName && story.epic_id ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={`size-1.5 shrink-0 rounded-sm ${getEpicDotClass(story.epic_id)}`} aria-hidden="true" />
          <span className="min-w-0 truncate">{epicName}</span>
        </div>
      ) : null}
      {/* E-MODERN A meta row — blocked=신호(text-warning+dot)·label 칩·line/gate=boy-scout 1배지(muted) */}
      {(blockedBy.length > 0 && story.status !== 'done') || labels.length > 0 || lineBadge ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {blockedBy.length > 0 && story.status !== 'done' ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-warning">
              <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
              {t('blockedBy', { count: blockedBy.length })}
            </span>
          ) : null}
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {lineBadge === 'pending_gate' ? (
            <Badge variant="outline" className="gap-1">
              <Pause className="size-3 shrink-0" />
              <span>{pendingGateType ? `${pendingGateType} ${tCage('gatePending')}` : tCage('gatePending')}</span>
            </Badge>
          ) : lineBadgeMeta ? (
            // 가디언 fold-in: 실 alert(handoff_stuck=destructive·waiting_human=warning)는 색=신호 유지,
            // 정보성(engine_degraded·grandfathered)만 outline. LINE_BADGE_META가 이미 그 위계라 variant 원복.
            <Badge variant={lineBadgeMeta.variant} className="gap-1">
              <lineBadgeMeta.Icon className="size-3 shrink-0" />
              <span>{tCage(lineBadgeMeta.labelKey)}</span>
            </Badge>
          ) : null}
        </div>
      ) : null}
      <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{story.title}</p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {assigneeList.length > 0 ? (
            <div className="flex -space-x-1.5">
              {assigneeList.slice(0, 3).map((m) => (
                <div
                  key={m.id}
                  className={`relative flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-medium ring-1 ring-background ${
                    m.type === 'agent'
                      ? 'border-accent-claim/30 bg-accent-claim/10 text-accent-claim'
                      : 'border-border bg-muted text-muted-foreground'
                  }`}
                  title={m.name}
                >
                  {getInitials(m.name)}
                  {m.type === 'agent' && (
                    <span className="absolute -bottom-px -right-px h-[6px] w-[6px] rounded-full bg-brand-strong ring-1 ring-background" />
                  )}
                </div>
              ))}
              {assigneeList.length > 3 && (
                <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-background">
                  +{assigneeList.length - 3}
                </div>
              )}
            </div>
          ) : (
            <div />
          )}
          {hasAgent && (
            <span className="inline-flex items-center gap-1 text-[10px] text-accent-claim">
              <span className="size-1.5 shrink-0 rounded-full bg-accent-claim" aria-hidden="true" />
              {t('filterAgents')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {story.story_points != null ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">{t('storyPointsBadge', { count: story.story_points })}</span>
          ) : null}
          {/* E-MODERN A: 액션 점진 공개 — 데스크탑 hover 노출·모바일(hover 없음)은 상시(kickoff 도달성=기능 동결 보존) */}
          <span className="flex items-center gap-1.5 opacity-100 transition focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
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
          </span>
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
