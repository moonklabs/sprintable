'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import type { RetroActionRecord, RetroItemRecord, RetroSessionPhase, RetroSessionRecord } from '@/services/retro-session';
import { OutcomeResultCard, type OutcomeResult } from '@/components/outcome/outcome-result-card';
import type { OutcomeStatus } from '@/components/outcome/outcome-status-badge';

type RetroItemCategory = 'good' | 'bad' | 'improve';

interface RetroMemberOption {
  id: string;
  name: string;
}

const PHASE_ORDER: RetroSessionPhase[] = ['collect', 'group', 'vote', 'discuss', 'action', 'closed'];

const PHASE_NEXT: Partial<Record<RetroSessionPhase, RetroSessionPhase>> = {
  collect: 'group',
  group: 'vote',
  vote: 'discuss',
  discuss: 'action',
  action: 'closed',
};

const PHASE_VARIANTS: Record<string, 'success' | 'info' | 'outline' | 'secondary'> = {
  collect: 'info',
  group: 'secondary',
  vote: 'outline',
  discuss: 'secondary',
  action: 'success',
  closed: 'outline',
};

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

  async function advancePhase() {
    if (!session || !projectId) return;
    const nextPhase = PHASE_NEXT[session.phase as RetroSessionPhase];
    if (!nextPhase) return;
    // B1(9f27af8f): 현재 VALID_TRANSITIONS는 전진 전용(역방향 불가) — 실수 advance 방지 확인.
    // phase-B(3단계+비차단 그룹/토론+양방향)는 BE VALID_TRANSITIONS 확정 후 별건 통합.
    if (!window.confirm(t('advanceConfirm', { next: t(PHASE_KEYS[nextPhase] as 'phaseCollect') }))) return;
    setAdvancing(true);
    setAdvanceError(null);
    try {
      const res = await fetch(`/api/retro-sessions/${sessionId}?project_id=${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: nextPhase }),
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

  type RetroTranslationKey = 'phaseCollect' | 'phaseGroup' | 'phaseVote' | 'phaseDiscuss' | 'phaseAction' | 'phaseClosed';
  const PHASE_KEYS: Record<string, RetroTranslationKey> = {
    collect: 'phaseCollect',
    group: 'phaseGroup',
    vote: 'phaseVote',
    discuss: 'phaseDiscuss',
    action: 'phaseAction',
    closed: 'phaseClosed',
  };

  const currentPhase = session?.phase as RetroSessionPhase | undefined;
  const nextPhase = currentPhase ? PHASE_NEXT[currentPhase] : undefined;
  const canAddItems = currentPhase === 'collect';
  const canVote = currentPhase === 'vote';
  const canAddActions = currentPhase === 'action';
  const showItems = currentPhase && ['collect', 'group', 'vote', 'discuss', 'action', 'closed'].includes(currentPhase);
  const showActions = currentPhase && ['action', 'closed'].includes(currentPhase);

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
            {session ? (
              <Badge variant={PHASE_VARIANTS[session.phase] ?? 'outline'}>
                {PHASE_KEYS[session.phase] ? t(PHASE_KEYS[session.phase] as 'phaseCollect') : session.phase}
              </Badge>
            ) : null}
          </div>
        }
        actions={
          session && session.phase !== 'closed' ? (
            <div className="flex items-center gap-2">
              {advanceError ? <span className="text-xs text-destructive">{advanceError}</span> : null}
              {nextPhase ? (
                <Button variant="hero" size="sm" onClick={() => void advancePhase()} disabled={advancing}>
                  {advancing ? t('advancing') : t('nextPhase')}
                </Button>
              ) : null}
            </div>
          ) : session?.phase === 'closed' ? (
            <Button variant="outline" size="sm" onClick={() => void exportSession()}>
              {t('export')}
            </Button>
          ) : null
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Phase stepper */}
        {session ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/80 px-6 py-3">
            {PHASE_ORDER.map((phase, index) => {
              const currentIndex = PHASE_ORDER.indexOf(session.phase as RetroSessionPhase);
              const isActive = phase === session.phase;
              const isDone = index < currentIndex;
              return (
                <div key={phase} className="flex items-center gap-1.5">
                  {index > 0 ? <span className="text-muted-foreground">›</span> : null}
                  <Badge
                    variant={isActive ? (PHASE_VARIANTS[phase] ?? 'outline') : isDone ? 'success' : 'outline'}
                    className={isDone ? 'opacity-50' : ''}
                  >
                    {t(PHASE_KEYS[phase] as 'phaseCollect')}
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
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  {CATEGORIES.map((category) => {
                    const categoryItems = items.filter((item) => item.category === category);
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
                            categoryItems.map((item) => {
                              const hasVoted = votedItemIds.has(item.id);
                              return (
                                <div key={item.id} className="flex items-start justify-between gap-2 rounded-lg border border-border/60 bg-background p-2.5">
                                  <p className="flex-1 text-sm text-foreground">{item.text}</p>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {item.vote_count > 0 ? (
                                      <span className="text-xs text-muted-foreground">{t('votes', { count: item.vote_count })}</span>
                                    ) : null}
                                    {canVote ? (
                                      <Button
                                        variant={hasVoted ? 'outline' : 'glass'}
                                        size="sm"
                                        onClick={() => void voteItem(item.id)}
                                        disabled={hasVoted}
                                        className="h-6 px-2 text-xs"
                                      >
                                        {hasVoted ? t('alreadyVoted') : t('vote')}
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })
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

              {/* Group / Discuss phases - read-only items */}
              {currentPhase && ['group', 'discuss'].includes(currentPhase) && !showItems ? null : null}
            </>
          )}
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
