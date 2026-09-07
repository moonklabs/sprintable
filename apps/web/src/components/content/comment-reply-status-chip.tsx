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
 * story #3593(Phase2·FE, 페드루 PO 確定 2026-09-06) — `repliesCount`는 additive
 * optional. 2건 이상(재상신 이력)이면 배지 낱말이 "답변 N · 최신 {status}"로
 * 바뀐다(1건이면 기존 그대로) — {status} 자리는 여전히 commentReplyStatusLabelKey
 * 그대로 넣어(유나 확定: 「발행됨」 등 상태 낱말 자체는 불변, 조합 문구만 새로).
 * story #3596(유나 Design CHANGES①, 페드루 PO 정정 2026-09-07) — `latestSentStatus`
 * additive optional. repliesCount(=sentRepliesCount)>=2 조합 문구의 status
 * 자리는 이 값이 있으면 그것을(보낸 답변 중 최신), 없으면(사실상 안 쓰이는
 * 자리) 기존 `status`로 폴백한다 — 임계 아래(단일 낱말) 칩은 여전히 `status`
 * 그대로(이 값 미사용, PO 스코프 정정).
 */
export function CommentReplyStatusChip({
  status, repliesCount, latestSentStatus,
}: { status: CommentReplyStatus; repliesCount?: number; latestSentStatus?: CommentReplyStatus | null }) {
  const t = useTranslations('content');
  const tone = COMMENT_REPLY_STATUS_TONE[status];
  const statusLabel = t(commentReplyStatusLabelKey(status));
  const countStatusLabel = t(commentReplyStatusLabelKey(latestSentStatus ?? status));
  const label = repliesCount != null && repliesCount >= 2
    ? t('commentsReplyCountStatusLabel', { count: repliesCount, status: countStatusLabel })
    : statusLabel;
  return (
    <span
      data-comment-reply-status-chip={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
    >
      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
