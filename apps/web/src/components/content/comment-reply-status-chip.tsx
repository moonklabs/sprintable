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
 * story #3592(유나 §22-16 ② 「제3의 답」, 페드루 PO 決 채택 2026-09-07 01:24Z) —
 * status 주어는 «항상» 이 컴포넌트의 `status` prop(=comment.replyStatus, 초안·
 * 실패 포함 현재 최신) 하나다 — 톤(칩 색)·낱말·아래 실패 줄이 이 한 주어로
 * 통일된다. 한때 있던 `latestSentStatus`(보낸 답변만의 최신 상태로 조합 문구의
 * status만 따로 갈아치우던 additive prop, story #3596 Design CHANGES①)는 이
 * 決으로 폐기됐다 — BE 필드(`latest_sent_reply_status`)도 같은 PR에서 은퇴
 * (응답 스키마·라우터·서비스 함수까지 전부 걷음, 죽은 필드 없음).
 */
export function CommentReplyStatusChip({
  status, repliesCount,
}: { status: CommentReplyStatus; repliesCount?: number }) {
  const t = useTranslations('content');
  const tone = COMMENT_REPLY_STATUS_TONE[status];
  const statusLabel = t(commentReplyStatusLabelKey(status));
  const label = repliesCount != null && repliesCount >= 2
    ? t('commentsReplyCountStatusLabel', { count: repliesCount, status: statusLabel })
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
