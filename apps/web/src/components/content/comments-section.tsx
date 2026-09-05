'use client';

import { useTranslations } from 'next-intl';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { CommentBodyText } from '@/components/content/comment-body-text';
import { CommentsRefreshButton, type CommentsRefreshOutcome } from '@/components/content/comments-refresh-button';
import { Button } from '@/components/ui/button';
import type { CommentReplyStatus } from '@/components/content/comment-reply-status';
import { CommentReplyStatusChip } from '@/components/content/comment-reply-status-chip';

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
  /** 이 댓글을 수집한 시각(항상 있다) — §22-10: externalCreatedAt이 없을 때만
   * 폴백으로 쓰되, 반드시 "수집" 라벨로 보인다("작성"으로 적으면 거짓말이다). */
  capturedAt: string;
  /** null이 아니면 지워진 댓글(§22-9) — 삭제됐어도 목록엔 원래 시간순 자리 그대로
   * 실린다(BE가 지우지 않고 실어 준다, text도 보존돼 온다 — "존재했던 사실"은 남긴다). */
  deletedAt: string | null;
  replyStatus: CommentReplyStatus;
  /** replyStatus==='published'일 때만 뜻이 있다(외부 채널에 실제로 올라간 답변
   * 링크) — 그 외 상태는 항상 null(지어내지 않는다). */
  replyExternalUrl: string | null;
}

// story #3517(유나 §22-②) — 세 얼굴. "미수집"(null)·"댓글 없음"([])·"불러오지 못함"(fetch
// 실패) 셋이 전부 다른 문구다 — 0·「—」로 수렴하면 "휴먼이 지금 무엇을 모르는지"가
// 사라진다(§17 "null≠0" 규율의 이 화면 버전). empty/loaded만 capturedAt을 가진다(수집이
// 실제로 일어난 시점 — uncollected/error는 아직 그 시점 자체가 없다, 지어내지 않는다).
//
// story #3517(BE #3865 REQUIRED 2, 유나 §22-9, PO 確定) — activeCount/deletedCount는
// 서버 전체 수(페이지 안 목록 길이가 아니다) — 헤더 「댓글 {activeCount}」·지워진 댓글
// 안내는 이 값으로 만든다(comments.length로 세면 offset/limit에 따라 틀린다).
// story #3517(유나 Design 재리뷰, 2026-09-05) — empty(active_count===0)도 comments를
// 싣는다. 지워진 행은 §22-9 "원래 자리 그대로"가 activeCount 판정과 무관하게 지켜져야
// 한다 — active 0·deleted N이면 empty 얼굴 "댓글이 없습니다" 문구 아래에 그 N개 지워진
// 행이 그대로(접힘) 그려진다(행이 사라지면 §22-9 위반).
export type CommentsFace =
  | { kind: 'uncollected' }
  | { kind: 'error' }
  | { kind: 'empty'; capturedAt: string; comments: CommentItem[]; activeCount: number; deletedCount: number; nextAllowedAt: string | null }
  | { kind: 'loaded'; capturedAt: string; comments: CommentItem[]; activeCount: number; deletedCount: number; nextAllowedAt: string | null };

/** BE #3865 조각①/#3876 조각②-b 원 응답 shape(snake_case) — GET .../publications/{id}/comments. */
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
    /** 조각②-b(BE #3876 additive) — 댓글당 최신 답변 1건 요약(배치 조인). null=무응답. */
    reply?: { id: string; status: string; external_reply_url: string | null; command_id: string | null } | null;
  }[];
  active_count: number;
  deleted_count: number;
  /** 조각②-b(BE #3876 additive, 유나 16회차) — 재수집 429 창의 다음 허용 시각.
   * null=지금 바로 재수집 가능. 다른 세션이 누른 창도 로드 시점에 이 값으로 안다. */
  comments_next_allowed_at?: string | null;
}

// story #3517 조각②-b(BE #3876, PO 確定 2026-09-06) — reply summary(BE raw status
// 'draft'|'pending'|'sent'|'failed' + command_id)를 화면 6종 CommentReplyStatus로
// 파생. §22-② "신호 없으면 자리 자체를 안 그린다" 원칙의 다음 단계 — 이제 신호가
// 있으니(reply 필드) 지어내지 않고 정직하게 그 값에서만 파생한다.
//   null(무응답) → none
//   'draft' → draft(사람이 아직 상신 안 함)
//   'pending'·command_id=null → submitted(상신됨, 승인 대기)
//   'pending'·command_id!=null → approved(승인됨, 발송 대기 — 워커가 아직 안 집음)
//   'sent' → published(외부 채널에 실제로 올라감, external_reply_url 있으면 링크)
//   'failed' → failed
export function deriveCommentReplyStatus(
  reply: { status: string; command_id: string | null } | null | undefined,
): CommentReplyStatus {
  // `== null`(느슨한 비교, undefined도 함께 잡는다) — 구버전 응답 픽스처·아직 이
  // 필드를 안 주는 소비처가 `reply` 키 자체를 생략하면 undefined로 온다. TS 타입은
  // null만 허용하지만 런타임은 그 계약을 강제 못 한다 — 방어적으로 둘 다 "무응답".
  if (reply == null) return 'none';
  switch (reply.status) {
    case 'draft': return 'draft';
    case 'pending': return reply.command_id !== null ? 'approved' : 'submitted';
    case 'sent': return 'published';
    case 'failed': return 'failed';
    default: return 'none';
  }
}

export function deriveCommentsFace(data: RawCommentsResponse): CommentsFace {
  if (data.last_collected_at === null) return { kind: 'uncollected' };
  const activeCount = data.active_count;
  const deletedCount = data.deleted_count;
  const nextAllowedAt = data.comments_next_allowed_at ?? null;
  const comments: CommentItem[] = data.comments.map((c) => ({
    id: c.id,
    authorDisplayName: c.author_display_name,
    bodyText: c.text,
    externalCreatedAt: c.external_created_at,
    capturedAt: c.captured_at,
    deletedAt: c.deleted_at,
    replyStatus: deriveCommentReplyStatus(c.reply),
    replyExternalUrl: c.reply?.external_reply_url ?? null,
  }));
  // story #3517(유나 §22-10, PO 確定 2026-09-05) — "댓글 없음" 판정은 active_count
  // 하나만 본다(comments.length 아님 — 페이지 잘림·지워진 행이 섞이면 틀린다).
  // deleted_count는 이 판정에 안 들어간다 — 활성 댓글이 0이면 지워진 행이 몇 개든
  // "댓글 없음"이다(그 지워진 행 자체는 empty 얼굴에도 §22-9 안내로 여전히 보인다,
  // 아래 empty 분기 참고).
  if (activeCount === 0) {
    return { kind: 'empty', capturedAt: data.last_collected_at, comments, activeCount, deletedCount, nextAllowedAt };
  }
  return { kind: 'loaded', capturedAt: data.last_collected_at, comments, activeCount, deletedCount, nextAllowedAt };
}

// story #3517(BE #3867 조각②, PO 確定 2026-09-05) — onConvertToTask/onReply 재도입.
// story #3517 조각②-b(BE #3876, PO 確定 2026-09-06) — 답변 상태 칩(CommentReplyStatusChip)
// 착지. 댓글 목록 GET(조각①)이 그때는 reply 존재 여부를 전혀 안 실어보내(그라운딩
// 확認) 지어내지 않고 안 그렸으나, #3876이 배치 조인 1회로 댓글마다 reply 요약
// {id, status, external_reply_url, command_id}을 실어보내면서 신호가 생겼다 —
// deriveCommentReplyStatus가 그 신호에서만 파생한다(§17 규율 그대로: 신호 없으면
// 여전히 'none', 지어내지 않는다).
export interface CommentsSectionProps {
  face: CommentsFace;
  displayTimezone: string;
  /** 수동 재수집(BE #3865 조각①). uncollected 포함 모든 얼굴에서 뜬다 — "아직
   * 수집 전"이어도 사람이 지금 바로 트리거할 수 있어야 한다(자동 수집을 기다리지
   * 않는다). onRefresh는 POST만 하고, 성공 뒤 목록을 다시 부르는 건 호출부(페이지)
   * 몫이다(이 컴포넌트는 재조회 트리거만 위임받는다). */
  onRefresh: () => Promise<CommentsRefreshOutcome>;
  /** §22-9 — 지워진 댓글엔 이 액션 자체가 안 그려진다(호출부는 신경 안 써도 됨,
   * CommentsList가 isDeleted로 이미 걸러 그 댓글에 대해선 이 콜백을 부르지 않는다). */
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

// story #3517(유나 Design 재리뷰, 2026-09-05) — empty/loaded 둘 다 같은 목록 렌더를
// 쓴다(§22-9 지워진 행 규칙이 두 얼굴에서 갈리면 안 되므로 한 곳으로 통일).
function CommentsList({
  comments, displayTimezone, t, onConvertToTask, onReply,
}: {
  comments: CommentItem[];
  displayTimezone: string;
  t: ReturnType<typeof useTranslations>;
  onConvertToTask: (comment: CommentItem) => void;
  onReply: (comment: CommentItem) => void;
}) {
  return (
    <ul className="space-y-3">
      {comments.map((comment) => {
        const isDeleted = comment.deletedAt !== null;
        return (
          <li key={comment.id} className="space-y-1.5 rounded-md border border-border p-3" data-testid="comments-item">
            <div className="flex items-center justify-between gap-2">
              {/* story #3517(유나 §22-10②, PO 確定 2026-09-05) — 작성자 없으면
                  공유 「모름」(originAuthorUnknown)이 아니라 이 화면 전용 문구
                  ("작성자 정보 없음", 흐린 한 줄) — §22-③ "채널이 준 만큼"이
                  구체적으로 뭘 못 받았는지 말한다. */}
              <span className="text-xs font-medium text-muted-foreground" data-testid="comments-item-author">
                {comment.authorDisplayName ?? t('commentsAuthorUnknown')}
              </span>
              {/* story #3517(유나 §22-10②) — external_created_at(작성 시각) 우선,
                  없으면 capturedAt(수집 시각)으로 폴백하되 라벨을 반드시 바꾼다
                  ("작성"이라 적으면 거짓말 — captured_at은 우리가 그 댓글을 발견한
                  시각일 뿐 채널에 올라온 시각이 아니다). */}
              {comment.externalCreatedAt ? (
                <span className="text-xs text-muted-foreground" data-testid="comments-item-authored-at">
                  {formatScheduledAt(comment.externalCreatedAt, displayTimezone).display}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid="comments-item-captured-at">
                  {t('commentsItemCapturedAtLabel', { time: formatScheduledAt(comment.capturedAt, displayTimezone).display })}
                </span>
              )}
            </div>
            {/* story #3517(§22-9, PO 지정 순서 2026-09-05) — 사유("원본이
                지워졌습니다")가 위, 본문("본문 펼치기")이 아래 — §22-9 문장
                순서. 본문은 길이 무관 기본 접힘(forceCollapsed), text는 BE가
                보존해서 준다(숨기지 않는다). */}
            {isDeleted ? (
              <p className="text-xs text-muted-foreground" data-testid="comments-item-deleted-note">
                {t('commentsDeletedNote')}
              </p>
            ) : null}
            <CommentBodyText
              text={comment.bodyText}
              moreLabel={t('commentsMoreLabel')}
              forceCollapsed={isDeleted}
              deletedSummaryLabel={t('commentsDeletedBodyLabel')}
            />
            {/* story #3517 조각②-b(BE #3876, PO 確定 2026-09-06) — 답변 상태 칩.
                comment.deletedAt(대상 댓글 삭제 여부)와는 다른 축이라 isDeleted와
                무관하게 항상 그린다(답변 자체의 생애주기는 대상 댓글 삭제로 안
                사라진다 — 이미 발행된 답변은 대상이 지워져도 발행된 채로 남는다). */}
            <div className="flex items-center gap-2" data-testid="comments-item-reply-status">
              <CommentReplyStatusChip status={comment.replyStatus} />
              {comment.replyStatus === 'published' && comment.replyExternalUrl ? (
                <a
                  href={comment.replyExternalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                  data-testid="comments-item-reply-external-link"
                >
                  {t('commentsReplyExternalLinkCta')}
                </a>
              ) : null}
            </div>
            {/* story #3517(BE #3867 조각②, PO 確定 2026-09-05) — §22-9: 지워진
                댓글엔 행 액션이 아예 안 그려진다(비활성이 아니라 부재). */}
            {!isDeleted ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onConvertToTask(comment)}
                  data-testid="comments-item-convert-to-task"
                >
                  {t('commentsConvertToTaskCta')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onReply(comment)}
                  data-testid="comments-item-reply"
                >
                  {t('commentsReplyCta')}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function CommentsSection({ face, displayTimezone, onRefresh, onConvertToTask, onReply }: CommentsSectionProps) {
  const t = useTranslations('content');

  if (face.kind === 'uncollected') {
    return (
      <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
        <h3 className="text-sm font-medium text-foreground">{t('commentsSectionTitle')}</h3>
        <p className="text-sm text-muted-foreground" data-testid="comments-face-uncollected">
          {t('commentsFaceUncollected')}
        </p>
        <CommentsRefreshButton onRefresh={onRefresh} />
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
        <CommentsRefreshButton onRefresh={onRefresh} />
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
        <CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={face.nextAllowedAt} displayTimezone={displayTimezone} />
        {/* story #3517(유나 Design 재리뷰, 2026-09-05) — active_count===0이어도
            지워진 행(deleted_count>0)은 §22-9 "원래 자리 그대로" 그린다 — "댓글
            없음" 문구가 지워진 행의 존재 자체를 지우면 안 된다. */}
        {face.comments.length > 0 ? (
          <CommentsList comments={face.comments} displayTimezone={displayTimezone} t={t} onConvertToTask={onConvertToTask} onReply={onReply} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
      <SectionHeader t={t} activeCount={face.activeCount} deletedCount={face.deletedCount} capturedAtDisplay={capturedAtDisplay} />
      <CommentsRefreshButton onRefresh={onRefresh} nextAllowedAt={face.nextAllowedAt} displayTimezone={displayTimezone} />
      <CommentsList comments={face.comments} displayTimezone={displayTimezone} t={t} onConvertToTask={onConvertToTask} onReply={onReply} />
    </div>
  );
}
