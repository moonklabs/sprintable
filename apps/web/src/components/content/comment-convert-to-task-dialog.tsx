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
import { getEntityHref } from '@/components/chat/embed-card';
import { CommentBodyText } from '@/components/content/comment-body-text';
import type { CommentItem } from '@/components/content/comments-section';

/**
 * story #3517(유나 §22-④, PO 確定 2026-09-05) — insights-board/follow-up-dialog.tsx(#3503)
 * 의 다이얼로그 골격(Dialog>DialogContent max-h-[85vh] flex flex-col sm:max-w-lg > form >
 * DialogFooter, 성공 시 인라인 story 링크·새 라우트 안 만듦)을 그대로 쓰되 variant가
 * 다르다 — 여기는 유형 3지선다가 없다(댓글 1건에서 출발하는 단일 경로). 제목 prefill은
 * 「[댓글] {게시물 제목}」 고정(댓글 본문은 제목에 안 실린다 — 다이얼로그 안에 그 댓글을
 * 별도로 보여준다, §22-④ 明示). BFF 자원명이 아직 확定 전이라(3516 조각①) 실제 POST는
 * onSubmit 콜백으로 뺐다 — 호출부가 계약 확定 뒤 fetchWithAuth를 배선한다.
 */
export interface CommentConvertToTaskDialogProps {
  postTitle: string;
  comment: CommentItem;
  onClose: () => void;
  onSubmit: (input: { title: string; note: string }) => Promise<{ ok: true; storyId: string } | { ok: false; errorMessage: string }>;
}

export function CommentConvertToTaskDialog({ postTitle, comment, onClose, onSubmit }: CommentConvertToTaskDialogProps) {
  const t = useTranslations('content');
  const prefillTitle = `${t('commentsConvertDialogTitlePrefix')} ${postTitle}`;
  const [title, setTitle] = useState(prefillTitle);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successStoryId, setSuccessStoryId] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await onSubmit({ title: title.trim() || prefillTitle, note: note.trim() });
      if (result.ok) {
        setSuccessStoryId(result.storyId);
      } else {
        setErrorMessage(result.errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const storyHref = successStoryId ? getEntityHref('story', successStoryId) : null;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('commentsConvertDialogTitle')}</DialogTitle>
        </DialogHeader>

        {successStoryId ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
              <AlertDescription>
                {t('commentsConvertSuccessMessage')}
                {storyHref ? (
                  <>
                    {' '}
                    <a href={storyHref} className="underline" data-testid="comments-convert-success-link">
                      {t('commentsConvertSuccessLink')}
                    </a>
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="outline" onClick={onClose}>{t('commentsConvertClose')}</Button>} />
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!submitting) void handleSubmit();
            }}
          >
            {/* §22-④ "댓글 본문은 제목에 안 싣는다 — 다이얼로그가 그 댓글을 보여 준다". */}
            <div className="shrink-0 space-y-1 rounded-md border border-border p-2">
              <p className="text-xs font-medium text-muted-foreground">{t('commentsConvertDialogSourceLabel')}</p>
              <CommentBodyText text={comment.bodyText} moreLabel={t('commentsMoreLabel')} />
            </div>

            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="comments-convert-title">
                {t('commentsConvertTitleLabel')}
              </label>
              <input
                id="comments-convert-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="comments-convert-note">
                {t('commentsConvertNoteLabel')}
              </label>
              <textarea
                id="comments-convert-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('commentsConvertNotePlaceholder')}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {errorMessage ? (
              <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                <AlertDescription data-testid="comments-convert-error">{errorMessage}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter className="shrink-0">
              <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{t('commentsConvertCancel')}</Button>} />
              <Button type="submit" disabled={submitting}>
                {submitting ? t('commentsConvertSubmitting') : t('commentsConvertSubmit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
