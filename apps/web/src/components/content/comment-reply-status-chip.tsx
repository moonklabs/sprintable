'use client';

import { useTranslations } from 'next-intl';
import {
  commentReplyStatusLabelKey,
  COMMENT_REPLY_STATUS_TONE,
  type CommentReplyStatus,
} from '@/components/content/comment-reply-status';

/**
 * story #3517(유나 §22-④) — status-chip.tsx(원문/변형 상태)와 같은 마크업·data attribute
 * 관례(measureChip 대비 헬퍼가 이 자리 하나만 보면 되게) — 댓글 답변 상태 6종 전용.
 */
export function CommentReplyStatusChip({ status }: { status: CommentReplyStatus }) {
  const t = useTranslations('content');
  const tone = COMMENT_REPLY_STATUS_TONE[status];
  return (
    <span
      data-comment-reply-status-chip={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
    >
      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {t(commentReplyStatusLabelKey(status))}
    </span>
  );
}
