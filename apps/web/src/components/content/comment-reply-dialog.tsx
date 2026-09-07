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

export type CommentReplyOutcome =
  | { ok: true; reply: ReplyView }
  | {
      ok: false;
      errorMessage: string;
      /** story #3596(페드루 PO 追加 2026-09-07) — create가 409(COMMENT_REPLY_
       * DRAFT_ALREADY_OPEN)로 막히면 BE가 기존 초안 id를 같이 돌려준다(레이스:
       * 이 다이얼로그를 열어 두고 있던 사이 다른 세션이 먼저 초안을 만든 경우
       * 등). 있으면 에러 배너 대신 그 초안으로 이어서(draft 뷰) 넘어간다. */
      existingReplyId?: string;
    };

export interface CommentReplyDialogProps {
  comment: CommentItem;
  onClose: () => void;
  onCreateDraft: (text: string) => Promise<CommentReplyOutcome>;
  onSubmit: (replyId: string) => Promise<CommentReplyOutcome>;
  /** story #3544 조각⑧(유나 §22-15 ⑧, PO 確定 2026-09-06) — voided(봉인 불일치)
   * 「다시 상신」이 여는 자리에서 «지금 답변» 원문을 미리 채운다(호출부가 단건 GET
   * .../replies/{replyId}로 가져와 넘긴다). 일반 「답변」(새로 시작)은 undefined —
   * 빈 칸 그대로. 「승인한 답변」과의 diff는 만들지 않는다(BE additive 前 — 못
   * 하는 것으로 명기, §22-15 ⑧). */
  initialText?: string;
  /** story #3544 후속⑨(유나 관찰, PO 確定 2026-09-06) — 조각⑧의 단건 GET이 실패하면
   * initialText는 undefined로 남아 일반 「답변」(새로 시작)의 빈 칸과 글자가 같아진다
   * — 「불러오다 실패했다」와 「원래 빈 칸이다」를 사람이 못 가른다. 이 플래그가 true면
   * textarea 위에 한 줄을 보여준다(실패해도 손으로 쓸 수는 있어 액션 0). */
  prefillFetchFailed?: boolean;
  /** story #3596(Phase2·FE, 페드루 PO 確定 2026-09-06, AC2·AC7) — 「이어서 답변」
   * (안 보낸 초안이 이미 있는 댓글)이 여는 자리. 이 값이 있으면 create 단계를
   * 건너뛰고 곧장 draft 뷰(상신 버튼)를 그린다 — 같은 댓글에 새 초안을 또
   * 만들면 서버가 409를 낸다(create_comment_reply_draft의 fail-closed 가드),
   * 그래서 이 흐름은 기존 초안 id를 그대로 재사용해 상신까지만 간다. */
  initialDraft?: { id: string; text: string };
  /** story #3596(AC10) — initialDraft 단건 GET이 실패했을 때 뜻이 있다. 기존
   * prefillFetchFailed(voided 「다시 상신」 전용, commentsReplyPrefillFetchFailed)와
   * 다른 문구(commentsReplyDraftPrefillFetchFailed) — 「지어낸 것」과 「작성하던
   * 것」은 다른 사고라 유나가 키를 갈랐다(재사용 0). */
  draftPrefillFetchFailed?: boolean;
  /** story #3596(페드루 PO 追加 2026-09-07) — create가 409+existingReplyId로
   * 막힌 자리에서 그 초안 원문을 단건 GET으로 가져온다(AC11 재사용 — 호출부가
   * 이미 handleContinueReply에 쓰는 그 왕복 그대로). 안 주면(또는 실패하면)
   * 빈 칸 + commentsReplyDraftPrefillFetchFailed로 안전 폴백. */
  onFetchReplyText?: (replyId: string) => Promise<string | undefined>;
}

/**
 * story #3517(유나 §22-⑤, BE #3867 조각②, PO 確定 2026-09-05) — 답변 초안→상신.
 * 승인·발행은 이 다이얼로그 밖(범용 게이트 승인, approvals-queue.tsx)에서 일어난다
 * — 상신 성공 시 "봉인됐다"는 사실과 대상 댓글 상태(current/changed/deleted)만
 * 여기서 보여주고, 승인 자체는 이 화면 책임이 아니다(§22-⑤ "승인 카드"는 게이트
 * 인박스의 몫).
 */
export function CommentReplyDialog({
  comment, onClose, onCreateDraft, onSubmit, initialText, prefillFetchFailed,
  initialDraft, draftPrefillFetchFailed, onFetchReplyText,
}: CommentReplyDialogProps) {
  const t = useTranslations('content');
  const [text, setText] = useState(initialText ?? '');
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(initialDraft ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ReplyView | null>(null);
  // story #3596(페드루 PO 追加 2026-09-07) — create가 409(existingReplyId)로 막혀
  // 그 초안으로 이어간 경우의 자체 fetch 실패(부모가 여는 시점의 draftPrefillFetchFailed
  // 와 별개 자리 — 열려 있는 이 다이얼로그 안에서 나중에 일어난다). 둘 다 같은 문구다.
  const [draftPrefillFailedAfterConflict, setDraftPrefillFailedAfterConflict] = useState(false);
  const showDraftPrefillFailed = (draftPrefillFetchFailed ?? false) || draftPrefillFailedAfterConflict;

  async function handleCreateDraft() {
    if (!text.trim()) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await onCreateDraft(text.trim());
      if (result.ok) {
        setDraft({ id: result.reply.id, text: result.reply.text });
      } else if (result.existingReplyId) {
        // story #3596 — 이 댓글에 안 보낸 초안이 이미 있다(레이스): 새로 만들지
        // 않고 그 초안으로 이어간다(create_comment_reply_draft의 409 가드가
        // 「안 다룬다」는 막아야 한다는 §3596 처방 그대로 — 재시도로 우회하지
        // 않는다).
        const fetchedText = onFetchReplyText ? await onFetchReplyText(result.existingReplyId) : undefined;
        setDraft({ id: result.existingReplyId, text: fetchedText ?? '' });
        setDraftPrefillFailedAfterConflict(fetchedText === undefined);
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
          {/* story #3596(유나 §22-16 ⑦, 페드루 PO 追加 2026-09-07, AC8 마지막
              조각) — sentRepliesCount는 목록이 이미 실어 준 값(추가 왕복 0).
              0이면 안 그린다(순번·본문 없이 수만 — 결재함 카드의 같은 줄은
              #3599 ⑥-1, 이 둘은 짝으로 같이 고친다). */}
          {comment.sentRepliesCount > 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="comments-reply-already-sent-count">
              {t('commentsReplyAlreadySentCount', { count: comment.sentRepliesCount })}
            </p>
          ) : null}
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
              {showDraftPrefillFailed ? (
                // story #3596(유나 Design CHANGES② 2026-09-07) — 이 화면은 읽기
                // 전용이라 "직접 적어 주세요"를 할 자리가 없고, text=''인 빈
                // 상자는 「모른다」가 아니라 「초안이 비었다」로 읽힌다(서버엔
                // 본문이 있는데 화면이 틀리게 말하는 자리) — 문구만 서고 상자
                // 자체를 안 그린다. 「상신」은 그대로 연다(서버가 이미 갖고
                // 있는 초안을 상신할 뿐이라 로컬 표시 실패가 그 능력을 안 막는다).
                <p className="text-xs text-muted-foreground" data-testid="comments-reply-draft-prefill-fetch-failed">
                  {t('commentsReplyDraftPrefillFetchFailed')}
                </p>
              ) : (
                <p className="whitespace-pre-wrap rounded-md border border-border p-2 text-sm text-foreground" data-testid="comments-reply-draft-text-box">{draft.text}</p>
              )}
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
              {prefillFetchFailed ? (
                <p className="text-xs text-muted-foreground" data-testid="comments-reply-prefill-fetch-failed">
                  {t('commentsReplyPrefillFetchFailed')}
                </p>
              ) : null}
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
