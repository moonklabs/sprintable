'use client';

import { useTranslations } from 'next-intl';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { CommentBodyText } from '@/components/content/comment-body-text';
import { CommentReplyStatusChip } from '@/components/content/comment-reply-status-chip';
import type { CommentReplyStatus } from '@/components/content/comment-reply-status';

export interface CommentItem {
  id: string;
  /** 채널이 표시명을 안 주면 null(지어내지 않는다 — §22-③ "작성자는 채널이 준 만큼"). */
  authorDisplayName: string | null;
  bodyText: string;
  externalCreatedAt: string;
  replyStatus: CommentReplyStatus;
}

// story #3517(유나 §22-②) — 세 얼굴. "미수집"(null)·"댓글 없음"([])·"불러오지 못함"(fetch
// 실패) 셋이 전부 다른 문구다 — 0·「—」로 수렴하면 "휴먼이 지금 무엇을 모르는지"가
// 사라진다(§17 "null≠0" 규율의 이 화면 버전). empty/loaded만 capturedAt을 가진다(수집이
// 실제로 일어난 시점 — uncollected/error는 아직 그 시점 자체가 없다, 지어내지 않는다).
export type CommentsFace =
  | { kind: 'uncollected' }
  | { kind: 'error' }
  | { kind: 'empty'; capturedAt: string }
  | { kind: 'loaded'; capturedAt: string; comments: CommentItem[] };

export interface CommentsSectionProps {
  face: CommentsFace;
  displayTimezone: string;
  onConvertToTask: (comment: CommentItem) => void;
  onReply: (comment: CommentItem) => void;
}

export function CommentsSection({ face, displayTimezone, onConvertToTask, onReply }: CommentsSectionProps) {
  const t = useTranslations('content');

  if (face.kind === 'uncollected') {
    return (
      <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
        <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitle')}</h3>
        <p className="text-sm text-muted-foreground" data-testid="comments-face-uncollected">
          {t('commentsFaceUncollected')}
        </p>
      </div>
    );
  }

  if (face.kind === 'error') {
    return (
      <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
        <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitle')}</h3>
        <p className="text-sm text-muted-foreground" data-testid="comments-face-error">
          {t('commentsFaceError')}
        </p>
      </div>
    );
  }

  const capturedAtDisplay = formatScheduledAt(face.capturedAt, displayTimezone).display;

  if (face.kind === 'empty') {
    return (
      <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitle')}</h3>
          <span className="text-xs text-muted-foreground" data-testid="comments-captured-at">
            {t('commentsCapturedAtLabel', { time: capturedAtDisplay })}
          </span>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="comments-face-empty">
          {t('commentsFaceEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitle')}</h3>
        <span className="text-xs text-muted-foreground" data-testid="comments-captured-at">
          {t('commentsCapturedAtLabel', { time: capturedAtDisplay })}
        </span>
      </div>
      <ul className="space-y-3">
        {face.comments.map((comment) => (
          <li key={comment.id} className="space-y-1.5 rounded-md border border-border p-3" data-testid="comments-item">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground" data-testid="comments-item-author">
                {comment.authorDisplayName ?? t('originAuthorUnknown')}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatScheduledAt(comment.externalCreatedAt, displayTimezone).display}
              </span>
            </div>
            <CommentBodyText text={comment.bodyText} moreLabel={t('commentsMoreLabel')} />
            <div className="flex items-center justify-between gap-2 pt-1">
              <CommentReplyStatusChip status={comment.replyStatus} />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onConvertToTask(comment)}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                  data-testid="comments-item-convert-to-task"
                >
                  {t('commentsConvertToTaskCta')}
                </button>
                <button
                  type="button"
                  onClick={() => onReply(comment)}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                  data-testid="comments-item-reply"
                >
                  {t('commentsReplyCta')}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
