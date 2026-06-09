'use client';

import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StandupEntrySummary, StandupFeedbackSummary, StandupMemberSummary } from './standup-review-card';

interface StandupBoardCardProps {
  member: StandupMemberSummary;
  entry?: StandupEntrySummary;
  feedback: StandupFeedbackSummary[];
  isCurrentUser: boolean;
  activeSprintTitle?: string | null;
  onEdit?: () => void;
  onOpenFeedback: () => void;
}

export function StandupBoardCard({
  member,
  entry,
  feedback,
  isCurrentUser,
  activeSprintTitle,
  onEdit,
  onOpenFeedback,
}: StandupBoardCardProps) {
  const t = useTranslations('standup');

  const approveCount = feedback.filter((f) => f.review_type === 'approve').length;
  const requestCount = feedback.filter((f) => f.review_type === 'request_changes').length;
  const commentCount = feedback.filter((f) => f.review_type === 'comment').length;

  return (
    <div className={cn('flex flex-col rounded-xl border border-border bg-card shadow-sm', isCurrentUser && 'ring-1 ring-brand/40')}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">{member.name}</span>
            {isCurrentUser && <Badge variant="info">{t('you')}</Badge>}
            <Badge variant={member.type === 'agent' ? 'secondary' : 'outline'}>
              {member.type === 'agent' ? t('agent') : t('human')}
            </Badge>
          </div>
          {activeSprintTitle ? (
            <span className="text-xs text-muted-foreground">{activeSprintTitle}</span>
          ) : null}
        </div>
        {isCurrentUser && onEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 text-xs">
            {t('editEntry')}
          </Button>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 p-4">
        {entry ? (
          <>
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-success">{t('doneLabel')}</div>
              <p className={cn('whitespace-pre-wrap text-sm', entry.done ? 'text-foreground/90' : 'text-muted-foreground')}>
                {entry.done || t('emptySection')}
              </p>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t('planLabel')}</div>
              <p className={cn('whitespace-pre-wrap text-sm', entry.plan ? 'text-foreground/90' : 'text-muted-foreground')}>
                {entry.plan || t('emptySection')}
              </p>
            </div>
            {entry.blockers ? (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-destructive">{t('blockersLabel')}</div>
                <p className="whitespace-pre-wrap text-sm text-foreground/90">
                  {entry.blockers}
                </p>
              </div>
            ) : null}
            {/* S3(51447ca0): org-level 작성을 프로젝트 뷰에 projection — 출처 표시 */}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden />
              {t('sourceOrgLevel')}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('notWrittenYet')}</p>
        )}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {approveCount > 0 ? <Badge variant="success">{t('feedbackApproveCount', { count: approveCount })}</Badge> : null}
          {requestCount > 0 ? <Badge variant="destructive">{t('feedbackRequestChangesCount', { count: requestCount })}</Badge> : null}
          {commentCount > 0 ? <Badge variant="info">{t('feedbackCommentCount', { count: commentCount })}</Badge> : null}
          {feedback.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('feedbackCount', { count: 0 })}</span>
          ) : null}
        </div>
        {entry && !isCurrentUser ? (
          <Button variant="glass" size="sm" onClick={onOpenFeedback} className="text-xs">
            {t('addFeedbackShort')}
          </Button>
        ) : entry ? (
          <Button variant="ghost" size="sm" onClick={onOpenFeedback} className="text-xs">
            {t('feedbackCount', { count: feedback.length })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
