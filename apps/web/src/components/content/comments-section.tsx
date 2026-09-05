'use client';

import { useTranslations } from 'next-intl';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { CommentBodyText } from '@/components/content/comment-body-text';
import { CommentReplyStatusChip } from '@/components/content/comment-reply-status-chip';
import type { CommentReplyStatus } from '@/components/content/comment-reply-status';

// story #3517(BE #3865 조각①, PO 確定 2026-09-05) — 필드명은 BE 응답
// (`{id, external_comment_id, author_display_name, text, external_created_at,
// captured_at, deleted_at}`)을 camelCase로 그대로 옮긴다. external_comment_id는
// 이 화면이 아직 안 쓴다(추후 딥링크용, 지금은 id만으로 충분).
export interface CommentItem {
  id: string;
  /** 채널이 표시명을 안 주면 null(지어내지 않는다 — §22-③ "작성자는 채널이 준 만큼"). */
  authorDisplayName: string | null;
  bodyText: string;
  /** BE 계약상 null 가능(채널이 시각을 안 줄 수 있다) — 지어내지 않는다. */
  externalCreatedAt: string | null;
  /** null이 아니면 지워진 댓글(§22-9) — 삭제됐어도 목록엔 원래 시간순 자리 그대로
   * 실린다(BE가 지우지 않고 실어 준다, text도 보존돼 온다 — "존재했던 사실"은 남긴다). */
  deletedAt: string | null;
  replyStatus: CommentReplyStatus;
}

// story #3517(유나 §22-②) — 세 얼굴. "미수집"(null)·"댓글 없음"([])·"불러오지 못함"(fetch
// 실패) 셋이 전부 다른 문구다 — 0·「—」로 수렴하면 "휴먼이 지금 무엇을 모르는지"가
// 사라진다(§17 "null≠0" 규율의 이 화면 버전). empty/loaded만 capturedAt을 가진다(수집이
// 실제로 일어난 시점 — uncollected/error는 아직 그 시점 자체가 없다, 지어내지 않는다).
//
// story #3517(BE #3865 REQUIRED 2, 유나 §22-9, PO 確定) — activeCount/deletedCount는
// 서버 전체 수(페이지 안 목록 길이가 아니다) — 헤더 「댓글 {activeCount}」·지워진 댓글
// 안내는 이 값으로 만든다(comments.length로 세면 offset/limit에 따라 틀린다).
export type CommentsFace =
  | { kind: 'uncollected' }
  | { kind: 'error' }
  | { kind: 'empty'; capturedAt: string; activeCount: number; deletedCount: number }
  | { kind: 'loaded'; capturedAt: string; comments: CommentItem[]; activeCount: number; deletedCount: number };

/** BE #3865 조각① 원 응답 shape(snake_case) — GET .../publications/{id}/comments. */
export interface RawCommentsResponse {
  last_collected_at: string | null;
  comments: {
    id: string;
    external_comment_id: string;
    author_display_name: string | null;
    text: string;
    external_created_at: string | null;
    captured_at: string;
    deleted_at: string | null;
  }[];
  active_count: number;
  deleted_count: number;
}

// story #3517(조각①만 착지, 조각② 대기) — 답변/작업전환 엔드포인트가 아직 없어
// 댓글마다 실제 답변 상태를 모른다. replyStatusFor를 안 주면 전부 'none'(지어내지
// 않는다 — 모른다고 '초안'·'승인' 등을 짐작하지 않는다). 조각② 착지 뒤 이 함수
// 호출부에 실제 판정 함수를 넘긴다(이 함수 자체는 안 바뀐다).
export function deriveCommentsFace(
  data: RawCommentsResponse,
  replyStatusFor?: (commentId: string) => CommentReplyStatus,
): CommentsFace {
  if (data.last_collected_at === null) return { kind: 'uncollected' };
  const activeCount = data.active_count;
  const deletedCount = data.deleted_count;
  const comments: CommentItem[] = data.comments.map((c) => ({
    id: c.id,
    authorDisplayName: c.author_display_name,
    bodyText: c.text,
    externalCreatedAt: c.external_created_at,
    deletedAt: c.deleted_at,
    replyStatus: replyStatusFor ? replyStatusFor(c.id) : 'none',
  }));
  if (activeCount === 0 && deletedCount === 0) {
    return { kind: 'empty', capturedAt: data.last_collected_at, activeCount, deletedCount };
  }
  return { kind: 'loaded', capturedAt: data.last_collected_at, comments, activeCount, deletedCount };
}

export interface CommentsSectionProps {
  face: CommentsFace;
  displayTimezone: string;
  onConvertToTask: (comment: CommentItem) => void;
  onReply: (comment: CommentItem) => void;
}

function SectionHeader({
  t, activeCount, deletedCount, capturedAtDisplay,
}: {
  t: ReturnType<typeof useTranslations>;
  activeCount: number;
  deletedCount: number;
  capturedAtDisplay: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitleWithCount', { count: activeCount })}</h3>
        <span className="text-xs text-muted-foreground" data-testid="comments-captured-at">
          {t('commentsCapturedAtLabel', { time: capturedAtDisplay })}
        </span>
      </div>
      {deletedCount > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="comments-deleted-count">
          {t('commentsDeletedCountLabel', { count: deletedCount })}
        </p>
      ) : null}
    </div>
  );
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
        <SectionHeader t={t} activeCount={face.activeCount} deletedCount={face.deletedCount} capturedAtDisplay={capturedAtDisplay} />
        <p className="text-sm text-muted-foreground" data-testid="comments-face-empty">
          {t('commentsFaceEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
      <SectionHeader t={t} activeCount={face.activeCount} deletedCount={face.deletedCount} capturedAtDisplay={capturedAtDisplay} />
      <ul className="space-y-3">
        {face.comments.map((comment) => {
          const isDeleted = comment.deletedAt !== null;
          return (
            <li key={comment.id} className="space-y-1.5 rounded-md border border-border p-3" data-testid="comments-item">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground" data-testid="comments-item-author">
                  {comment.authorDisplayName ?? t('originAuthorUnknown')}
                </span>
                {/* BE 계약상 external_created_at은 null 가능(채널이 시각을 안 줄 수 있다) —
                    없으면 이 자리 자체를 안 그린다(지어내지 않는다, §17 규율). */}
                {comment.externalCreatedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {formatScheduledAt(comment.externalCreatedAt, displayTimezone).display}
                  </span>
                ) : null}
              </div>
              {/* story #3517(§22-9) — 지워진 댓글: 본문은 길이 무관 기본 접힘(forceCollapsed)
                  + "원본이 지워졌습니다" 한 줄. text는 BE가 보존해서 준다(숨기지 않는다). */}
              <CommentBodyText text={comment.bodyText} moreLabel={t('commentsMoreLabel')} forceCollapsed={isDeleted} />
              {isDeleted ? (
                <p className="text-xs text-muted-foreground" data-testid="comments-item-deleted-note">
                  {t('commentsDeletedNote')}
                </p>
              ) : null}
              {/* §22-9 — 지워진 댓글엔 행 액션 자체를 안 그린다(비활성이 아니라 부재 —
                  사유는 위 안내 줄이 이미 진다, 버튼 밖 사유 문구를 또 안 만든다). */}
              {!isDeleted ? (
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
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
