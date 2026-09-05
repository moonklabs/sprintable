'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CommentBodyText } from '@/components/content/comment-body-text';
import type { CommentItem } from '@/components/content/comments-section';

/** BE #3867 ReplyView(계약표) — snake_case 그대로(단건 다이얼로그 세션 안에서만
 * 쓴다, comments-section의 CommentItem처럼 camelCase로 옮겨 붙일 만큼 오래 살지
 * 않는다 — 이 다이얼로그를 닫으면 사라진다, 그라운딩 §참고: 댓글 목록 GET에 이
 * 정보가 없어 페이지 재로드 시 복원 불가). */
export interface ReplyView {
  id: string;
  comment_id: string;
  text: string;
  status: string;
  gate_id: string | null;
  external_reply_id: string | null;
  external_reply_url: string | null;
  last_error: string | null;
  target_comment_state: 'current' | 'changed' | 'deleted' | null;
}

export type CommentReplyOutcome = { ok: true; reply: ReplyView } | { ok: false; errorMessage: string };

export interface CommentReplyDialogProps {
  comment: CommentItem;
  onClose: () => void;
  onCreateDraft: (text: string) => Promise<CommentReplyOutcome>;
  onSubmit: (replyId: string) => Promise<CommentReplyOutcome>;
}

/**
 * story #3517(유나 §22-⑤, BE #3867 조각②, PO 確定 2026-09-05) — 답변 초안→상신.
 * 승인·발행은 이 다이얼로그 밖(범용 게이트 승인, approvals-queue.tsx)에서 일어난다
 * — 상신 성공 시 "봉인됐다"는 사실과 대상 댓글 상태(current/changed/deleted)만
 * 여기서 보여주고, 승인 자체는 이 화면 책임이 아니다(§22-⑤ "승인 카드"는 게이트
 * 인박스의 몫).
 */
export function CommentReplyDialog({ comment, onClose, onCreateDraft, onSubmit }: CommentReplyDialogProps) {
  const t = useTranslations('content');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<ReplyView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ReplyView | null>(null);

  async function handleCreateDraft() {
    if (!text.trim()) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await onCreateDraft(text.trim());
      if (result.ok) {
        setDraft(result.reply);
      } else {
        setErrorMessage(result.errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitReply() {
    if (!draft) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await onSubmit(draft.id);
      if (result.ok) {
        setSubmitted(result.reply);
      } else {
        setErrorMessage(result.errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('commentsReplyDialogTitle')}</DialogTitle>
        </DialogHeader>

        {/* §22-③ "댓글은 남의 글" — 대상 댓글을 항상 함께 보여준다(무엇에 답하는지). */}
        <div className="shrink-0 space-y-1 rounded-md border border-border p-2">
          <p className="text-xs font-medium text-muted-foreground">{t('commentsConvertDialogSourceLabel')}</p>
          <CommentBodyText text={comment.bodyText} moreLabel={t('commentsMoreLabel')} />
        </div>

        {submitted ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
              <AlertDescription>{t('commentsReplySubmittedMessage')}</AlertDescription>
            </Alert>
            {/* §22-⑤ "봉인 축 셋" — 답변 본문·대상 댓글(위에 이미 표시)·대상 댓글 상태. */}
            <div className="space-y-1 rounded-md border border-border p-2">
              <p className="text-xs font-medium text-muted-foreground">{t('commentsReplySealedTextLabel')}</p>
              <p className="whitespace-pre-wrap text-sm text-foreground" data-testid="comments-reply-sealed-text">{submitted.text}</p>
            </div>
            {submitted.target_comment_state === 'changed' ? (
              <Alert variant="default" role="status" data-testid="comments-reply-target-changed">
                <AlertDescription>{t('commentsReplyTargetChanged')}</AlertDescription>
              </Alert>
            ) : null}
            {submitted.target_comment_state === 'deleted' ? (
              <Alert variant="destructive" role="alert" data-testid="comments-reply-target-deleted">
                <AlertDescription>{t('commentsReplyTargetDeletedAfterSubmit')}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="outline" onClick={onClose}>{t('commentsConvertClose')}</Button>} />
            </DialogFooter>
          </div>
        ) : draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="shrink-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('commentsReplyDraftLabel')}</p>
              <p className="whitespace-pre-wrap rounded-md border border-border p-2 text-sm text-foreground">{draft.text}</p>
            </div>
            {errorMessage ? (
              <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                <AlertDescription data-testid="comments-reply-error">{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{t('commentsConvertCancel')}</Button>} />
              <Button type="button" disabled={submitting} onClick={() => void handleSubmitReply()} data-testid="comments-reply-submit-button">
                {submitting ? t('commentsReplySubmitting') : t('commentsReplySubmitCta')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); if (!submitting) void handleCreateDraft(); }}
          >
            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="comments-reply-text">
                {t('commentsReplyTextLabel')}
              </label>
              <textarea
                id="comments-reply-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('commentsReplyTextPlaceholder')}
                rows={4}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {errorMessage ? (
              <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                <AlertDescription data-testid="comments-reply-error">{errorMessage}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{t('commentsConvertCancel')}</Button>} />
              <Button type="submit" disabled={submitting || !text.trim()} data-testid="comments-reply-draft-button">
                {submitting ? t('commentsReplySavingDraft') : t('commentsReplySaveDraftCta')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
