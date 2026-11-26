'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DndContext, KeyboardSensor, MouseSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Avatar } from '@/components/ds/avatar';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { ContextMenu, ContextMenuTrigger, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ds/menu';
import { CountBadge } from '@/components/ds/count-badge';
import { IconButton } from '@/components/ds/icon-button';
import { ProgressBar } from '@/components/ds/progress-bar';
import { NativeSelect } from '@/components/ds/select';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { sessionStateLabel } from '@/components/chat/agent-session-strip';
import { cn } from '@/lib/utils';
import { withProjectParam } from '@/lib/with-project-param';
import { deriveControlBoard, type BoardFace, type BoardProject, type FaceWord } from './derive-control-board';
import { useControlBoard, type BoardOutcome } from './use-control-board';

/**
 * story 5033 (C3 · 홈 = 한눈에 관제) — the home's top: one line per project (progress + the faces placed in it), the «열외» lane under them, and one filter (the whole org ↔ one project) on top.
 * LOOKS + two hands: dragging a face onto a channel = 배치 (access given) · onto «열외» = 열외 (that project's access taken back) · the SAME two are in the face's menu (right-click, or the ⋯ button — a phone has no drag).
 * Press count (held by a test): a drag is ONE gesture; the menu is TWO presses (open it · pick the entry). No confirm step — both are reversible by the other (and the line below the board says what was done).
 * A viewer who may not read the placement (not an org owner/admin) sees every face and its state and nothing to press.
 */

const DOT: Record<FaceWord, string> = {
  working: 'bg-ds-action',
  resting: 'bg-ds-ink-3',
  blocked: 'bg-ds-failed',
  offline: 'bg-ds-background ring-1 ring-inset ring-ds-line-control',
};

export const BENCH_ID = 'bench';
export const channelDropId = (projectId: string): string => `channel:${projectId}`;

/** what a drop means (pure — the test holds it): a face from channel X onto channel Y places it in Y; onto the lane takes it out of X; anywhere else, nothing */
export type DropAction = { kind: 'place'; agentId: string; projectId: string } | { kind: 'takeOut'; agentId: string; projectId: string } | null;
export function resolveDrop(from: { agentId: string; projectId: string | null }, overId: string | null): DropAction {
  if (!overId) return null;
  if (overId === BENCH_ID) return from.projectId ? { kind: 'takeOut', agentId: from.agentId, projectId: from.projectId } : null;
  if (!overId.startsWith('channel:')) return null;
  const projectId = overId.slice('channel:'.length);
  return projectId && projectId !== from.projectId ? { kind: 'place', agentId: from.agentId, projectId } : null;
}

interface FaceActions {
  /** null = nothing can be pressed (the viewer may not manage the placement) */
  canWrite: boolean;
  projects: BoardProject[];
  placedIn: (agentId: string) => Set<string>;
  onPlace: (face: BoardFace, project: BoardProject) => void;
  onTakeOut: (face: BoardFace, project: BoardProject) => void;
  busyKey: string | null;
}

function FaceMenuItems({ face, channel, actions }: { face: BoardFace; channel: BoardProject | null; actions: FaceActions }) {
  const t = useTranslations('orgBriefing');
  const placed = actions.placedIn(face.agentId);
  const targets = actions.projects.filter((p) => !placed.has(p.id));
  return (
    <>
      {targets.map((p) => (
        <MenuItem key={p.id} icon="add" onClick={() => actions.onPlace(face, p)} data-testid="control-menu-place">{t('menuPlaceIn', { project: p.name })}</MenuItem>
      ))}
      {channel ? <MenuItem icon="logout" onClick={() => actions.onTakeOut(face, channel)} data-testid="control-menu-take-out">{t('menuTakeOut', { project: channel.name })}</MenuItem> : null}
      {targets.length === 0 && !channel ? <MenuItem disabled>{t('menuNothingToDo')}</MenuItem> : null}
    </>
  );
}

function Face({ face, channel, actions }: { face: BoardFace; channel: BoardProject | null; actions: FaceActions }) {
  const t = useTranslations('orgBriefing');
  const tState = useTranslations('chats.agentSession');
  const tAgents = useTranslations('agents');
  const dragId = `${channel?.id ?? BENCH_ID}::${face.agentId}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragId, data: { agentId: face.agentId, projectId: channel?.id ?? null }, disabled: !actions.canWrite });
  const { row } = face;
  const href = row.conversation_id && row.conversation_project_id ? withProjectParam(`/chats/${row.conversation_id}`, row.conversation_project_id) : null;
  const sentence = row.state === null ? tAgents('agentNotConnected') : sessionStateLabel(row, tState);
  const body = (
    <div
      className={cn('flex min-w-0 items-center gap-2 rounded-ds-control border border-ds-line bg-ds-surface px-2 py-1.5', isDragging && 'opacity-50')}
      data-testid="control-face" data-agent-id={face.agentId} data-word={face.word} data-channel={channel?.id ?? BENCH_ID}
      title={`${face.name} · ${sentence}`}
    >
      {actions.canWrite ? (
        <IconButton ref={setNodeRef} {...listeners} {...attributes} icon="drag_indicator" label={t('faceDragLabel', { name: face.name })} className="touch:hidden cursor-grab" data-testid="control-face-handle" />
      ) : null}
      <Avatar name={face.name} actorType="agent" size={28} decorative />
      <div className="min-w-0">
        {href
          ? <Link href={href} className="block max-w-40 truncate text-ds-body font-medium text-ds-ink hover:underline">{face.name}</Link>
          : <span className="block max-w-40 truncate text-ds-body font-medium text-ds-ink">{face.name}</span>}
        <span className="flex items-center gap-1.5 text-ds-small text-ds-ink-2" data-testid="control-face-state">
          <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT[face.word])} data-testid="control-face-dot" />
          {({ working: () => t('faceWorking'), resting: () => t('faceResting'), blocked: () => t('faceBlocked'), offline: () => t('faceOffline') })[face.word]()}
        </span>
      </div>
      {actions.canWrite ? (
        <Menu>
          <MenuTrigger render={<IconButton icon="more_horiz" label={t('faceMenuLabel', { name: face.name })} data-testid="control-face-menu" disabled={actions.busyKey !== null} />} />
          <MenuContent align="end"><FaceMenuItems face={face} channel={channel} actions={actions} /></MenuContent>
        </Menu>
      ) : null}
    </div>
  );
  if (!actions.canWrite) return body;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="min-w-0" />}>{body}</ContextMenuTrigger>
      <MenuContent align="start"><FaceMenuItems face={face} channel={channel} actions={actions} /></MenuContent>
    </ContextMenu>
  );
}

function DropZone({ id, canWrite, className, children, testId }: { id: string; canWrite: boolean; className?: string; children: React.ReactNode; testId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !canWrite });
  return <div ref={setNodeRef} className={cn(className, isOver && 'ring-2 ring-inset ring-ds-action')} data-testid={testId} data-drop-id={id}>{children}</div>;
}

export interface ControlBoardViewProps {
  model: ReturnType<typeof deriveControlBoard>;
  projects: BoardProject[];
  filterProjectId: string | null;
  onFilter: (projectId: string | null) => void;
  actions: FaceActions;
  outcome: BoardOutcome;
  onDrop: (action: NonNullable<DropAction>) => void;
}

/** the board itself (a pure view of the model — the test mounts it with a model) */
export function ControlBoardView({ model, projects, filterProjectId, onFilter, actions, outcome, onDrop }: ControlBoardViewProps) {
  const t = useTranslations('orgBriefing');
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const onDragEnd = (e: DragEndEvent) => {
    const from = e.active.data.current as { agentId: string; projectId: string | null } | undefined;
    if (!from) return;
    const action = resolveDrop(from, e.over ? String(e.over.id) : null);
    if (action) onDrop(action);
  };
  const outcomeText = outcome
    ? t(outcome.kind === 'placed' ? 'outcomePlaced' : outcome.kind === 'tookOut' ? 'outcomeTookOut' : 'outcomeFailed', { agent: outcome.agentName, project: outcome.projectName })
    : null;
  return (
    <section aria-label={t('boardTitle')} data-testid="control-board" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t('boardTitle')}</h2>
        <NativeSelect className="w-52" aria-label={t('boardFilterLabel')} value={filterProjectId ?? ''} onChange={(e) => onFilter(e.target.value || null)} data-testid="control-filter">
          <option value="">{t('boardFilterAll')}</option>
          {[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface" data-testid="control-channels">
          {model.channels.length === 0 ? <p className="m-0 px-4 py-6 text-center text-ds-small text-ds-ink-3">{t('boardNoProjects')}</p> : null}
          {model.channels.map((c) => (
            <DropZone key={c.projectId} id={channelDropId(c.projectId)} canWrite={actions.canWrite} testId="control-channel" className="border-t border-ds-line px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-channel-id={c.projectId}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ds-body font-semibold text-ds-ink" data-testid="control-channel-name">{c.name}</span>
                  {c.needsHand > 0 ? <CountBadge kind="needs-hand" label={t('boardNeedsHand')} count={c.needsHand} data-testid="control-channel-needs-hand" /> : null}
                </div>
                <div className="min-w-40 flex-1 sm:max-w-80" data-testid="control-channel-progress">
                  {c.progress
                    ? <ProgressBar value={c.progress.done} max={c.progress.total} aria-label={t('boardProgressLabel', { project: c.name })} ariaValueText={t('boardProgressText', { done: c.progress.done, total: c.progress.total })} />
                    : <span className="text-ds-small text-ds-ink-3">{t('boardNoEpic')}</span>}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2" data-testid="control-channel-faces">
                {c.faces.length === 0
                  ? <span className="text-ds-small text-ds-ink-3">{model.readOnly ? t('boardPlacementUnknown') : t('boardNoAgents')}</span>
                  : c.faces.map((f) => <Face key={f.agentId} face={f} channel={byId.get(c.projectId) ?? null} actions={actions} />)}
              </div>
            </DropZone>
          ))}
        </div>
        <DropZone id={BENCH_ID} canWrite={actions.canWrite} testId="control-bench" className="rounded-ds-control border border-dashed border-ds-line-control px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h3 className="m-0 text-ds-body font-semibold text-ds-ink">{model.readOnly ? t('benchTitleReadOnly') : t('benchTitle')}</h3>
            {actions.canWrite ? <span className="text-ds-small text-ds-ink-3">{filterProjectId ? t('benchHintFiltered') : t('benchHint')}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2" data-testid="control-bench-faces">
            {model.bench.length === 0
              ? <span className="text-ds-small text-ds-ink-3">{t('benchEmpty')}</span>
              : model.bench.map((f) => <Face key={f.agentId} face={f} channel={null} actions={actions} />)}
          </div>
        </DropZone>
      </DndContext>
      {outcomeText ? <div data-testid="control-outcome"><Banner tone={outcome?.kind === 'failed' ? 'failed' : 'info'}>{outcomeText}</Banner></div> : null}
    </section>
  );
}

/** the board of the home (reads · derives · writes) */
export function ControlBoard({ needsHandByProject }: { needsHandByProject: Record<string, number> }) {
  const t = useTranslations('orgBriefing');
  const tc = useTranslations('common');
  const board = useControlBoard();
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const model = useMemo(
    () => deriveControlBoard({ projects: board.projects, epics: board.epics, agents: board.agents, grants: board.grants, filterProjectId, needsHandByProject }),
    [board.projects, board.epics, board.agents, board.grants, filterProjectId, needsHandByProject],
  );
  if (board.failed && !board.loaded) {
    return (
      <div role="status" className="flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="control-board-error">
        <span>{t('boardLoadError')}</span>
        <Button size="md" variant="secondary" onClick={() => void board.retry()}>{tc('retry')}</Button>
      </div>
    );
  }
  if (!board.loaded) {
    return <SkeletonGroup label={t('boardTitle')} data-testid="control-board-loading"><Skeleton className="h-24" /></SkeletonGroup>;
  }
  if (board.projects.length === 0) return null; // no project: the home's own banners say it
  const byId = new Map(board.projects.map((p) => [p.id, p]));
  const agentById = new Map(board.agents.map((a) => [a.agent_id, a]));
  const placedIn = (agentId: string): Set<string> => new Set(board.projects.filter((p) => board.grants?.[`${agentId}::${p.id}`] !== undefined).map((p) => p.id));
  const actions: FaceActions = {
    canWrite: board.grants !== null,
    projects: board.projects,
    placedIn,
    onPlace: (face, project) => void board.place({ id: face.agentId, name: face.name }, project),
    onTakeOut: (face, project) => void board.takeOut({ id: face.agentId, name: face.name }, project),
    busyKey: board.busyKey,
  };
  return (
    <ControlBoardView
      model={model}
      projects={board.projects}
      filterProjectId={filterProjectId}
      onFilter={setFilterProjectId}
      actions={actions}
      outcome={board.outcome}
      onDrop={(a) => {
        const project = byId.get(a.projectId);
        const row = agentById.get(a.agentId);
        if (!project || !row) return;
        const agent = { id: row.agent_id, name: row.agent_name };
        void (a.kind === 'place' ? board.place(agent, project) : board.takeOut(agent, project));
      }}
    />
  );
}
