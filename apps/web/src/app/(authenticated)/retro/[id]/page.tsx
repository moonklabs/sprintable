'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorInput, OperatorSelect, OperatorTextarea } from '@/components/ui/operator-control';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';
import {
  RETRO_PHASE_TO_STAGE,
  RETRO_STAGE_ORDER,
  RETRO_STAGE_VARIANTS,
  type RetroActionRecord,
  type RetroItemRecord,
  type RetroSessionPhase,
  type RetroSessionRecord,
  type RetroVisibleStage,
} from '@/services/retro-session';
import { OutcomeResultCard, type OutcomeResult } from '@/components/outcome/outcome-result-card';
import type { OutcomeStatus } from '@/components/outcome/outcome-status-badge';

type RetroItemCategory = 'good' | 'bad' | 'improve';
type VisibleStage = RetroVisibleStage;

interface RetroMemberOption {
  id: string;
  name: string;
}

const STAGE_ORDER = RETRO_STAGE_ORDER;
const PHASE_TO_STAGE = RETRO_PHASE_TO_STAGE;
const STAGE_VARIANTS = RETRO_STAGE_VARIANTS;

// 다음/이전 버튼이 실제 PATCH할 BE phase — group/discuss를 건너뛰고 vote/action으로 직행.
// PATCH API(`/{id}/phase {phase}`)는 그대로, 스킵·역방향 전이는 디디의 병렬 BE 작업 완료 후 라이브 연결.
const STAGE_TO_PHASE: Record<VisibleStage, RetroSessionPhase> = {
  collect: 'collect',
  priority: 'vote',
  action: 'action',
  closed: 'closed',
};

const STAGE_NEXT: Partial<Record<VisibleStage, VisibleStage>> = {
  collect: 'priority',
  priority: 'action',
  action: 'closed',
};

const STAGE_PREV: Partial<Record<VisibleStage, VisibleStage>> = {
  priority: 'collect',
  action: 'priority',
  closed: 'action',
};

// B2(9f27af8f): 드래그-겹침 병합 카드 — draggable(자신을 옮김)+droppable(다른 카드가 이 위에 떨어짐)을
// 동시 등록. canMerge=false(우선순위 단계 아님)면 리스너 미부착 — 일반 카드처럼 정적 표시.
function MergeableItemCard({
  item,
  hasVoted,
  canVote,
  canMerge,
  childItems,
  onVote,
  onUngroup,
  t,
}: {
  item: RetroItemRecord;
  hasVoted: boolean;
  canVote: boolean;
  canMerge: boolean;
  childItems: RetroItemRecord[];
  onVote: (itemId: string) => void;
  onUngroup: (itemId: string) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const draggable = useDraggable({ id: item.id, disabled: !canMerge });
  const droppable = useDroppable({ id: item.id, disabled: !canMerge });
  const style = draggable.transform
    ? { transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={(node) => { draggable.setNodeRef(node); droppable.setNodeRef(node); }}
      style={style}
      {...(canMerge ? draggable.listeners : {})}
      {...(canMerge ? draggable.attributes : {})}
      className={cn(
        'rounded-lg border bg-background p-2.5 transition',
        droppable.isOver ? 'border-primary ring-1 ring-primary' : 'border-border/60',
        canMerge && 'cursor-grab touch-none active:cursor-grabbing',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 text-sm text-foreground">{item.text}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {item.vote_count > 0 ? (
            <span className="text-xs text-muted-foreground">{t('votes', { count: item.vote_count })}</span>
          ) : null}
          {canVote ? (
            <Button
              variant={hasVoted ? 'outline' : 'glass'}
              size="sm"
              onClick={() => onVote(item.id)}
              disabled={hasVoted}
              className="h-6 px-2 text-xs"
            >
              {hasVoted ? t('alreadyVoted') : t('vote')}
            </Button>
          ) : null}
        </div>
      </div>

      {childItems.length > 0 ? (
        <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
          <Badge variant="chip">{t('mergedCount', { count: childItems.length })}</Badge>
          {childItems.map((child) => (
            <div key={child.id} className="flex items-center justify-between gap-2 pl-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{child.text}</span>
              {canMerge ? (
                <button type="button" onClick={() => onUngroup(child.id)} className="shrink-0 hover:text-foreground">
                  {t('ungroup')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function RetroSessionPage() {
  const t = useTranslations('retro');
  const { projectId, currentTeamMemberId } = useDashboardContext();
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [session, setSession] = useState<RetroSessionRecord | null>(null);
  const [items, setItems] = useState<RetroItemRecord[]>([]);
  const [actions, setActions] = useState<RetroActionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [votedItemIds, setVotedItemIds] = useState<Set<string>>(new Set());
  const { toasts, addToast, dismissToast } = useToast();

  const [sprintOutcome, setSprintOutcome] = useState<{
    status: OutcomeStatus; hypothesis: string | null; result: OutcomeResult | null; metric?: string;
  } | null>(null);

  useEffect(() => {
    if (!session?.sprint_id) { setSprintOutcome(null); return; }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/sprints/${session.sprint_id}`);
      if (!res.ok || cancelled) return;
      const { data } = await res.json() as { data?: { outcome_status?: string; success_hypothesis?: string | null; outcome_result?: OutcomeResult | null; metric_definition?: { metric?: string } | null } };
      if (data?.outcome_status && data.outcome_status !== 'n_a') {
        setSprintOutcome({ status: data.outcome_status as OutcomeStatus, hypothesis: data.success_hypothesis ?? null,
          result: data.outcome_result ?? null, metric: data.metric_definition?.metric });
      } else setSprintOutcome(null);
    })();
    return () => { cancelled = true; };
  }, [session?.sprint_id]);

  const [newItemText, setNewItemText] = useState<Record<RetroItemCategory, string>>({ good: '', bad: '', improve: '' });
  const [addingItem, setAddingItem] = useState<RetroItemCategory | null>(null);
  const [addItemError, setAddItemError] = useState<string | null>(null);
  // B1(9f27af8f): discuss 옵셔널 메모 — 세션-로컬 스크래치패드(BE 미저장, 정직하게 고지된 비영속 메모).
  const [discussNotes, setDiscussNotes] = useState('');

  const [newActionText, setNewActionText] = useState('');
  const [newActionAssigneeId, setNewActionAssigneeId] = useState('');
  const [addingAction, setAddingAction] = useState(false);
  const [addActionError, setAddActionError] = useState<string | null>(null);

  // B3(9f27af8f): 액션 담당자 선택용 멤버 목록 — org-level, 신규 fetch 1회.
  const [members, setMembers] = useState<RetroMemberOption[]>([]);
  const [togglingActionId, setTogglingActionId] = useState<string | null>(null);
  const memberNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const member of members) map[member.id] = member.name;
    return map;
  }, [members]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/team-members');
      if (!res.ok || cancelled) return;
      const json = await res.json().catch(() => null) as { data?: RetroMemberOption[] } | null;
      if (json?.data && !cancelled) setMembers(json.data);
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!projectId || !sessionId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}?project_id=${projectId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: RetroSessionRecord & { items?: RetroItemRecord[]; actions?: RetroActionRecord[] } };
      const loadedItems = json.data.items ?? [];
      setSession(json.data);
      setItems(loadedItems);
      setActions(json.data.actions ?? []);
      // B4(9f27af8f): voted_by_me가 응답에 실리면 새로고침 후에도 투표 상태 복원(필드 부재 시 기존 동작 그대로).
      const hydratedVotes = loadedItems.filter((item) => item.voted_by_me).map((item) => item.id);
      if (hydratedVotes.length > 0) {
        setVotedItemIds((prev) => new Set([...prev, ...hydratedVotes]));
      }
    } catch {
      setLoadError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId, t]);

  useEffect(() => { void load(); }, [load]);

  // B1(9f27af8f): 양방향 스테이지 이동 — PATCH `/{id}/phase {phase}` API 그대로, group/discuss를
  // 건너뛰는 skip 전이·역방향 전이는 디디의 병렬 BE VALID_TRANSITIONS 작업이 배포된 후 라이브 연결.
  async function goToStage(targetStage: VisibleStage) {
    if (!session || !projectId || !currentStage) return;
    const targetPhase = STAGE_TO_PHASE[targetStage];
    const isForward = STAGE_ORDER.indexOf(targetStage) > STAGE_ORDER.indexOf(currentStage);
    const confirmKey = isForward ? 'stageForwardConfirm' : 'stageBackConfirm';
    if (!window.confirm(t(confirmKey, { stage: t(STAGE_KEYS[targetStage]) }))) return;
    setAdvancing(true);
    setAdvanceError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}?project_id=${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: targetPhase }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: RetroSessionRecord };
      setSession(json.data);
    } catch {
      setAdvanceError(t('advanceFailed'));
    } finally {
      setAdvancing(false);
    }
  }

  async function addItem(category: RetroItemCategory) {
    const text = newItemText[category].trim();
    if (!text || !projectId || !currentTeamMemberId) return;
    setAddingItem(category);
    setAddItemError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/items?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text, author_id: currentTeamMemberId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: RetroItemRecord };
      setItems((prev) => [...prev, json.data]);
      setNewItemText((prev) => ({ ...prev, [category]: '' }));
    } catch {
      setAddItemError(t('addItemFailed'));
    } finally {
      setAddingItem(null);
    }
  }

  async function voteItem(itemId: string) {
    if (!projectId || votedItemIds.has(itemId)) return;
    setVotedItemIds((prev) => new Set([...prev, itemId]));
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/items/${itemId}/vote?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setVotedItemIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
        return;
      }
      setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, vote_count: item.vote_count + 1 } : item));
    } catch {
      setVotedItemIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
    }
  }

  // B2(9f27af8f, BE #1804): 병합 — BE가 vote_count/grouped_item_ids를 서버측에서 재계산하므로
  // 로컬 패치 대신 세션 전체를 재조회(다수 아이템이 함께 바뀜 — parent vote_count도 갱신됨).
  const [groupError, setGroupError] = useState<string | null>(null);

  async function groupItem(itemId: string, parentItemId: string) {
    if (!projectId) return;
    setGroupError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/items/${itemId}/group?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_item_id: parentItemId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setGroupError(t('groupFailed'));
    }
  }

  async function ungroupItem(itemId: string) {
    if (!projectId) return;
    setGroupError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/items/${itemId}/ungroup?project_id=${projectId}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setGroupError(t('groupFailed'));
    }
  }

  function handleItemDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeItem = items.find((item) => item.id === active.id);
    if (!activeItem || activeItem.parent_item_id) return;
    void groupItem(String(active.id), String(over.id));
  }

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  async function addAction() {
    const text = newActionText.trim();
    if (!text || !projectId) return;
    setAddingAction(true);
    setAddActionError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/actions?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: text, assignee_id: newActionAssigneeId || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: RetroActionRecord };
      setActions((prev) => [...prev, json.data]);
      setNewActionText('');
      setNewActionAssigneeId('');
    } catch {
      setAddActionError(t('addActionFailed'));
    } finally {
      setAddingAction(false);
    }
  }

  // B3(9f27af8f): 완료 토글 — PATCH /api/retro-sessions/:id/actions/:action_id
  async function toggleActionStatus(action: RetroActionRecord) {
    if (!projectId) return;
    const nextStatus = action.status === 'done' ? 'open' : 'done';
    setTogglingActionId(action.id);
    setAddActionError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/actions/${action.id}?project_id=${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: RetroActionRecord };
      setActions((prev) => prev.map((item) => item.id === action.id ? json.data : item));
    } catch {
      setAddActionError(t('addActionFailed'));
    } finally {
      setTogglingActionId(null);
    }
  }

  async function exportSession() {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}/export?project_id=${projectId}`);
      if (!res.ok) return;
      const json = await res.json() as { data: { markdown: string } };
      await navigator.clipboard.writeText(json.data.markdown);
      addToast({ title: t('exportCopied'), type: 'success' });
    } catch {
      // ignore
    }
  }

  type StageTranslationKey = 'phaseCollect' | 'stagePriority' | 'phaseAction' | 'phaseClosed';
  const STAGE_KEYS: Record<VisibleStage, StageTranslationKey> = {
    collect: 'phaseCollect',
    priority: 'stagePriority',
    action: 'phaseAction',
    closed: 'phaseClosed',
  };

  const currentPhase = session?.phase as RetroSessionPhase | undefined;
  const currentStage = currentPhase ? PHASE_TO_STAGE[currentPhase] : undefined;
  const nextStage = currentStage ? STAGE_NEXT[currentStage] : undefined;
  const prevStage = currentStage ? STAGE_PREV[currentStage] : undefined;
  const canAddItems = currentStage === 'collect';
  const canVote = currentStage === 'priority';
  const canMerge = currentStage === 'priority';
  const canAddActions = currentStage === 'action';
  const showItems = currentStage !== undefined;
  const showActions = currentStage === 'action' || currentStage === 'closed';

  const CATEGORIES: RetroItemCategory[] = ['good', 'bad', 'improve'];
  const CATEGORY_LABEL_KEY: Record<RetroItemCategory, 'categoryGood' | 'categoryBad' | 'categoryImprove'> = {
    good: 'categoryGood',
    bad: 'categoryBad',
    improve: 'categoryImprove',
  };
  const CATEGORY_COLORS: Record<RetroItemCategory, string> = {
    good: 'text-success',
    bad: 'text-destructive',
    improve: 'text-warning',
  };
  const CATEGORY_DOT_COLORS: Record<RetroItemCategory, string> = {
    good: 'bg-success',
    bad: 'bg-destructive',
    improve: 'bg-warning',
  };

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            <Link href="/retro" className="text-xs text-muted-foreground hover:text-foreground">
              {t('backToList')}
            </Link>
            <span className="text-muted-foreground">/</span>
            <h1 className="text-sm font-medium">{session?.title ?? '...'}</h1>
            {session && currentStage ? (
              <Badge variant={STAGE_VARIANTS[currentStage]}>
                {t(STAGE_KEYS[currentStage])}
              </Badge>
            ) : null}
          </div>
        }
        actions={
          session ? (
            <div className="flex items-center gap-2">
              {advanceError ? <span className="text-xs text-destructive">{advanceError}</span> : null}
              {prevStage ? (
                <Button variant="outline" size="sm" onClick={() => void goToStage(prevStage)} disabled={advancing}>
                  {t('previousPhase')}
                </Button>
              ) : null}
              {nextStage ? (
                <Button variant="hero" size="sm" onClick={() => void goToStage(nextStage)} disabled={advancing}>
                  {advancing ? t('advancing') : t('nextPhase')}
                </Button>
              ) : null}
              {currentStage === 'closed' ? (
                <Button variant="outline" size="sm" onClick={() => void exportSession()}>
                  {t('export')}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* B1(9f27af8f): 3단계(+closed) 스테퍼 */}
        {session && currentStage ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/80 px-6 py-3">
            {STAGE_ORDER.map((stage, index) => {
              const currentIndex = STAGE_ORDER.indexOf(currentStage);
              const isActive = stage === currentStage;
              const isDone = index < currentIndex;
              return (
                <div key={stage} className="flex items-center gap-1.5">
                  {index > 0 ? <span className="text-muted-foreground">›</span> : null}
                  <Badge
                    variant={isActive ? STAGE_VARIANTS[stage] : isDone ? 'success' : 'outline'}
                    className={isDone ? 'opacity-50' : ''}
                  >
                    {t(STAGE_KEYS[stage])}
                  </Badge>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="space-y-6 p-6">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-32 animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : loadError ? (
            <EmptyState
              title={loadError}
              description={t('loadFailedDescription')}
              action={<Button variant="hero" onClick={() => void load()}>{t('retry')}</Button>}
            />
          ) : (
            <>
              {/* Linked sprint outcome card */}
              {sprintOutcome ? (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('linkedSprintOutcome')}</p>
                  <OutcomeResultCard
                    status={sprintOutcome.status}
                    hypothesis={sprintOutcome.hypothesis}
                    result={sprintOutcome.result}
                    pendingMetricLabel={sprintOutcome.metric}
                  />
                </div>
              ) : null}

              {/* Items grid */}
              {showItems ? (
                <div className="space-y-2">
                  {canMerge ? <p className="text-xs text-muted-foreground">{t('mergeHint')}</p> : null}
                  {groupError ? <p className="text-xs text-destructive">{groupError}</p> : null}
                  <DndContext sensors={dndSensors} onDragEnd={handleItemDragEnd}>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      {CATEGORIES.map((category) => {
                        // B2(9f27af8f): top-level만 렌더(child는 부모 카드 내부에서만 표시).
                        const categoryItems = items.filter((item) => item.category === category && !item.parent_item_id);
                        return (
                          <div key={category} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                            <h2 className={cn('flex items-center gap-1.5 text-sm font-semibold', CATEGORY_COLORS[category])}>
                              <span className={cn('h-2 w-2 rounded-full', CATEGORY_DOT_COLORS[category])} aria-hidden />
                              {t(CATEGORY_LABEL_KEY[category])}
                            </h2>

                            <div className="flex-1 space-y-2">
                              {categoryItems.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t('noItems')}</p>
                              ) : (
                                categoryItems.map((item) => (
                                  <MergeableItemCard
                                    key={item.id}
                                    item={item}
                                    hasVoted={votedItemIds.has(item.id)}
                                    canVote={canVote}
                                    canMerge={canMerge}
                                    childItems={items.filter((child) => child.parent_item_id === item.id)}
                                    onVote={voteItem}
                                    onUngroup={ungroupItem}
                                    t={t}
                                  />
                                ))
                              )}
                            </div>

                            {canAddItems ? (
                              <div className="space-y-2 border-t border-border/60 pt-3">
                                {addItemError ? <p className="text-xs text-destructive">{addItemError}</p> : null}
                                <OperatorTextarea
                                  value={newItemText[category]}
                                  onChange={(e) => setNewItemText((prev) => ({ ...prev, [category]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void addItem(category); } }}
                                  placeholder={t('addItemPlaceholder')}
                                  rows={2}
                                />
                                <Button
                                  variant="hero"
                                  size="sm"
                                  onClick={() => void addItem(category)}
                                  disabled={!newItemText[category].trim() || addingItem === category}
                                  className="w-full"
                                >
                                  {addingItem === category ? t('addingItem') : t('addItem')}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </DndContext>
                </div>
              ) : null}

              {/* B1(9f27af8f): discuss = 비차단 옵셔널 메모(로컬 전용, BE 영속 모델 없음 — 정직하게 미저장 고지) */}
              {currentStage === 'action' ? (
                <details className="rounded-xl border border-dashed border-border bg-card p-4">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">{t('discussNotesLabel')}</summary>
                  <p className="mt-1 text-xs text-muted-foreground">{t('discussNotesHint')}</p>
                  <OperatorTextarea
                    value={discussNotes}
                    onChange={(e) => setDiscussNotes(e.target.value)}
                    rows={3}
                    placeholder={t('discussNotesPlaceholder')}
                    className="mt-2"
                  />
                </details>
              ) : null}

              {/* Actions section */}
              {showActions ? (
                <div className="rounded-xl border border-border bg-card p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-foreground">{t('actions')}</h2>
                    {actions.length > 0 ? (
                      <Badge variant="outline">
                        {t('actionProgress', { done: actions.filter((a) => a.status === 'done').length, total: actions.length })}
                      </Badge>
                    ) : null}
                  </div>

                  {actions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('noActions')}</p>
                  ) : (
                    <div className="space-y-2">
                      {actions.map((action) => {
                        const isDone = action.status === 'done';
                        return (
                          <div key={action.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isDone}
                              onClick={() => void toggleActionStatus(action)}
                              disabled={togglingActionId === action.id}
                              className={cn(
                                'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition',
                                isDone ? 'border-success bg-success-tint text-success' : 'border-input bg-transparent',
                              )}
                            >
                              {isDone ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                            </button>
                            <p className={cn('flex-1 text-sm', isDone ? 'text-muted-foreground line-through' : 'text-foreground')}>
                              {action.title}
                            </p>
                            <Badge variant="chip">
                              {action.assignee_id ? (memberNameById[action.assignee_id] ?? t('actionUnassigned')) : t('actionUnassigned')}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {canAddActions ? (
                    <div className="space-y-2 border-t border-border/60 pt-3">
                      {addActionError ? <p className="text-xs text-destructive">{addActionError}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <OperatorInput
                          type="text"
                          value={newActionText}
                          onChange={(e) => setNewActionText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void addAction(); }}
                          placeholder={t('addActionPlaceholder')}
                          className="flex-1"
                        />
                        <OperatorSelect value={newActionAssigneeId} onChange={(e) => setNewActionAssigneeId(e.target.value)} className="w-auto">
                          <option value="">{t('actionUnassigned')}</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>{member.name}</option>
                          ))}
                        </OperatorSelect>
                        <Button
                          variant="hero"
                          size="sm"
                          onClick={() => void addAction()}
                          disabled={!newActionText.trim() || addingAction}
                        >
                          {addingAction ? t('addingAction') : t('addAction')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
