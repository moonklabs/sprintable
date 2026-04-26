'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OperatorSelect, OperatorTextarea } from '@/components/ui/operator-control';
import { cn } from '@/lib/utils';
import type {
  StandupEntrySummary,
  StandupFeedbackSummary,
  StandupMemberSummary,
  StandupReviewType,
  StandupStorySummary,
} from './standup-review-card';

interface StandupFeedbackDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  member: StandupMemberSummary;
  entry?: StandupEntrySummary;
  feedback: StandupFeedbackSummary[];
  stories: StandupStorySummary[];
  memberNameById: Record<string, string>;
  currentMemberId?: string | null;
  onCreateFeedback: (input: { standup_entry_id: string; review_type: StandupReviewType; feedback_text: string }) => Promise<void> | void;
  onUpdateFeedback: (feedbackId: string, input: { review_type?: StandupReviewType; feedback_text?: string }) => Promise<void> | void;
  onDeleteFeedback: (feedbackId: string) => Promise<void> | void;
}

const REVIEW_TYPE_OPTIONS: StandupReviewType[] = ['comment', 'approve', 'request_changes'];

function getReviewTypeVariant(type: StandupReviewType): 'info' | 'success' | 'destructive' {
  if (type === 'approve') return 'success';
  if (type === 'request_changes') return 'destructive';
  return 'info';
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function StandupFeedbackDialog({
  open,
  onOpenChange,
  member,
  entry,
  feedback,
  stories,
  memberNameById,
  currentMemberId,
  onCreateFeedback,
  onUpdateFeedback,
  onDeleteFeedback,
}: StandupFeedbackDialogProps) {
  const t = useTranslations('standup');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [reviewType, setReviewType] = useState<StandupReviewType>('comment');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [editingReviewType, setEditingReviewType] = useState<StandupReviewType>('comment');
  const [editingFeedbackText, setEditingFeedbackText] = useState('');
  const [savingFeedbackId, setSavingFeedbackId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setShowFeedbackForm(false);
      setFeedbackText('');
      setReviewType('comment');
      setEditingFeedbackId(null);
      setEditingReviewType('comment');
      setEditingFeedbackText('');
      setActionError(null);
    }
  }, [open]);

  useEffect(() => {
    if (editingFeedbackId && !feedback.some((item) => item.id === editingFeedbackId)) {
      setEditingFeedbackId(null);
      setEditingFeedbackText('');
      setEditingReviewType('comment');
    }
  }, [editingFeedbackId, feedback]);

  const linkedStories = useMemo(() => {
    const planStoryIds = entry?.plan_story_ids ?? [];
    return planStoryIds
      .map((storyId) => stories.find((story) => story.id === storyId))
      .filter((story): story is StandupStorySummary => Boolean(story));
  }, [entry?.plan_story_ids, stories]);

  const canAddFeedback = Boolean(entry) && currentMemberId !== member.id;

  async function submitFeedback() {
    if (!entry || !feedbackText.trim()) return;
    setSubmittingFeedback(true);
    setActionError(null);
    try {
      await onCreateFeedback({
        standup_entry_id: entry.id,
        review_type: reviewType,
        feedback_text: feedbackText.trim(),
      });
      setFeedbackText('');
      setReviewType('comment');
      setShowFeedbackForm(false);
    } catch {
      setActionError(t('actionFailed'));
    } finally {
      setSubmittingFeedback(false);
    }
  }

  function startEditFeedback(item: StandupFeedbackSummary) {
    setEditingFeedbackId(item.id);
    setEditingReviewType(item.review_type);
    setEditingFeedbackText(item.feedback_text);
  }

  async function saveFeedbackEdit(item: StandupFeedbackSummary) {
    if (!editingFeedbackText.trim()) return;
    setSavingFeedbackId(item.id);
    setActionError(null);
    try {
      await onUpdateFeedback(item.id, {
        review_type: editingReviewType,
        feedback_text: editingFeedbackText.trim(),
      });
      setEditingFeedbackId(null);
      setEditingFeedbackText('');
      setEditingReviewType('comment');
    } catch {
      setActionError(t('actionFailed'));
    } finally {
      setSavingFeedbackId(null);
    }
  }

  async function deleteFeedback(item: StandupFeedbackSummary) {
    const confirmed = window.confirm(t('deleteFeedbackConfirm'));
    if (!confirmed) return;
    setSavingFeedbackId(item.id);
    setActionError(null);
    try {
      await onDeleteFeedback(item.id);
      if (editingFeedbackId === item.id) {
        setEditingFeedbackId(null);
        setEditingFeedbackText('');
        setEditingReviewType('comment');
      }
    } catch {
      setActionError(t('actionFailed'));
    } finally {
      setSavingFeedbackId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{t('feedbackDialogTitle', { name: member.name })}</span>
            <Badge variant={member.type === 'agent' ? 'secondary' : 'outline'}>
              {member.type === 'agent' ? t('agent') : t('human')}
            </Badge>
            {entry ? <Badge variant="chip">{entry.date}</Badge> : <Badge variant="outline">{t('noEntries')}</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Done / Plan / Blockers 전체 텍스트 */}
          {entry ? (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400">{t('doneLabel')}</div>
                <p className={cn('mt-2 whitespace-pre-wrap text-sm text-[color:var(--operator-foreground)]/90', !entry.done && 'text-[color:var(--operator-muted)]')}>
                  {entry.done || t('emptySection')}
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--operator-primary-soft)]">{t('planLabel')}</div>
                <p className={cn('mt-2 whitespace-pre-wrap text-sm text-[color:var(--operator-foreground)]/90', !entry.plan && 'text-[color:var(--operator-muted)]')}>
                  {entry.plan || t('emptySection')}
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-rose-300">{t('blockersLabel')}</div>
                <p className={cn('mt-2 whitespace-pre-wrap text-sm text-[color:var(--operator-foreground)]/90', !entry.blockers && 'text-[color:var(--operator-muted)]')}>
                  {entry.blockers || t('emptySection')}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--operator-muted)]">{t('notWrittenYet')}</p>
          )}

          {/* 연결된 스토리 */}
          {linkedStories.length > 0 ? (
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--operator-muted)]">{t('linkedStories')}</p>
                <Badge variant="outline">{t('linkedStoryCount', { count: linkedStories.length })}</Badge>
              </div>
              <div className="space-y-2">
                {linkedStories.map((story) => (
                  <div key={story.id} className="rounded-md border border-border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{story.title}</p>
                      <Badge variant="outline">{story.status}</Badge>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-[color:var(--operator-muted)]">
                      <Badge variant="chip">{story.assignee_name ?? t('unknown')}</Badge>
                      <span>{t('taskProgress', { done: story.done_task_count, total: story.task_count })}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${story.task_count > 0 ? Math.round((story.done_task_count / story.task_count) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 피드백 섹션 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--operator-muted)]">{t('feedback')}</p>
              {canAddFeedback ? (
                <Button variant="glass" size="sm" onClick={() => setShowFeedbackForm((prev) => !prev)}>
                  {showFeedbackForm ? t('cancel') : t('addFeedback')}
                </Button>
              ) : null}
            </div>

            {actionError ? <p className="text-sm text-rose-300">{actionError}</p> : null}

            {feedback.length === 0 ? (
              <p className="text-sm text-[color:var(--operator-muted)]">{t('noFeedback')}</p>
            ) : (
              <div className="space-y-2">
                {feedback.map((item) => {
                  const authorName = memberNameById[item.feedback_by_id] ?? t('unknown');
                  const isAuthor = currentMemberId === item.feedback_by_id;
                  const isEditing = editingFeedbackId === item.id;
                  return (
                    <div key={item.id} className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={getReviewTypeVariant(item.review_type)}>{t(`reviewType_${item.review_type}`)}</Badge>
                          <span className="text-sm font-medium text-[color:var(--operator-foreground)]">{authorName}</span>
                        </div>
                        <span className="text-xs text-[color:var(--operator-muted)]">{formatTimestamp(item.created_at)}</span>
                      </div>
                      {isEditing ? (
                        <div className="mt-3 space-y-3">
                          <OperatorSelect value={editingReviewType} onChange={(e) => setEditingReviewType(e.target.value as StandupReviewType)}>
                            {REVIEW_TYPE_OPTIONS.map((option) => (
                              <option key={option} value={option}>{t(`reviewType_${option}`)}</option>
                            ))}
                          </OperatorSelect>
                          <OperatorTextarea
                            value={editingFeedbackText}
                            onChange={(e) => setEditingFeedbackText(e.target.value)}
                            rows={3}
                            placeholder={t('feedbackPlaceholder')}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button variant="hero" size="sm" onClick={() => void saveFeedbackEdit(item)} disabled={savingFeedbackId === item.id || !editingFeedbackText.trim()}>
                              {savingFeedbackId === item.id ? t('saving') : t('saveFeedback')}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => { setEditingFeedbackId(null); setEditingFeedbackText(''); setEditingReviewType('comment'); }}>
                              {t('cancel')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-[color:var(--operator-foreground)]/90">{item.feedback_text}</p>
                          {isAuthor ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button variant="outline" size="sm" onClick={() => startEditFeedback(item)}>{t('editFeedback')}</Button>
                              <Button variant="destructive" size="sm" onClick={() => void deleteFeedback(item)} disabled={savingFeedbackId === item.id}>{t('deleteFeedback')}</Button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {showFeedbackForm ? (
              <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                <OperatorSelect value={reviewType} onChange={(e) => setReviewType(e.target.value as StandupReviewType)}>
                  {REVIEW_TYPE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{t(`reviewType_${option}`)}</option>
                  ))}
                </OperatorSelect>
                <OperatorTextarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  rows={3}
                  placeholder={t('feedbackPlaceholder')}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="hero" size="sm" onClick={() => void submitFeedback()} disabled={submittingFeedback || !feedbackText.trim()}>
                    {submittingFeedback ? t('saving') : t('submitFeedback')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowFeedbackForm(false)}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
