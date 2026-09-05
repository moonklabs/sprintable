// story #3517(유나 §22-④) — 댓글 «행마다» 독립적인 답변 상태 6종. post-status.ts::
// CONTENT_POST_STATUS_TONE과 같은 톤 체계를 재사용한다(새 색 발명 0 — tint 배경 위
// 글자는 text-foreground 규율 그대로, #2534/#2932 교훈).
export type CommentReplyStatus = 'none' | 'draft' | 'submitted' | 'approved' | 'published' | 'failed';

export const COMMENT_REPLY_STATUS_TONE: Record<
  CommentReplyStatus,
  { bg: string; dot: string; text: string }
> = {
  // "무응답"은 post-status.ts에 대응 상태가 없다(콘텐츠 초안은 항상 어떤 상태든 있지만,
  // 댓글은 «아직 답변을 시작 안 함»이라는 진짜 영상태가 있다) — draft와 같은 muted
  // 톤이되 라벨로만 구분한다.
  none: { bg: 'bg-muted', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  draft: { bg: 'bg-muted', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  // "상신"=게이트 pending과 같은 축이라 warning 톤(post-status.ts의 pending 재사용).
  submitted: { bg: 'bg-warning-tint', dot: 'bg-warning', text: 'text-foreground' },
  approved: { bg: 'bg-info-tint', dot: 'bg-info', text: 'text-foreground' },
  published: { bg: 'bg-success-tint', dot: 'bg-success', text: 'text-foreground' },
  failed: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
};

export function commentReplyStatusLabelKey(status: CommentReplyStatus): string {
  switch (status) {
    case 'none': return 'commentsReplyStatusNone';
    case 'draft': return 'commentsReplyStatusDraft';
    case 'submitted': return 'commentsReplyStatusSubmitted';
    case 'approved': return 'commentsReplyStatusApproved';
    case 'published': return 'commentsReplyStatusPublished';
    case 'failed': return 'commentsReplyStatusFailed';
  }
}
