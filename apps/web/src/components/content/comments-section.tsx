'use client';

import { useTranslations } from 'next-intl';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { CommentBodyText } from '@/components/content/comment-body-text';
import { CommentsRefreshButton, type CommentsRefreshOutcome } from '@/components/content/comments-refresh-button';
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
  /** 이 댓글을 수집한 시각(항상 있다) — §22-10: externalCreatedAt이 없을 때만
   * 폴백으로 쓰되, 반드시 "수집" 라벨로 보인다("작성"으로 적으면 거짓말이다). */
  capturedAt: string;
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
// story #3517(유나 Design 재리뷰, 2026-09-05) — empty(active_count===0)도 comments를
// 싣는다. 지워진 행은 §22-9 "원래 자리 그대로"가 activeCount 판정과 무관하게 지켜져야
// 한다 — active 0·deleted N이면 empty 얼굴 "댓글이 없습니다" 문구 아래에 그 N개 지워진
// 행이 그대로(접힘) 그려진다(행이 사라지면 §22-9 위반).
export type CommentsFace =
  | { kind: 'uncollected' }
  | { kind: 'error' }
  | { kind: 'empty'; capturedAt: string; comments: CommentItem[]; activeCount: number; deletedCount: number }
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
    capturedAt: c.captured_at,
    deletedAt: c.deleted_at,
    replyStatus: replyStatusFor ? replyStatusFor(c.id) : 'none',
  }));
  // story #3517(유나 §22-10, PO 確定 2026-09-05) — "댓글 없음" 판정은 active_count
  // 하나만 본다(comments.length 아님 — 페이지 잘림·지워진 행이 섞이면 틀린다).
  // deleted_count는 이 판정에 안 들어간다 — 활성 댓글이 0이면 지워진 행이 몇 개든
  // "댓글 없음"이다(그 지워진 행 자체는 empty 얼굴에도 §22-9 안내로 여전히 보인다,
  // 아래 empty 분기 참고).
  if (activeCount === 0) {
    return { kind: 'empty', capturedAt: data.last_collected_at, comments, activeCount, deletedCount };
  }
  return { kind: 'loaded', capturedAt: data.last_collected_at, comments, activeCount, deletedCount };
}

// story #3517(PO 確定 2026-09-05) — onConvertToTask/onReply는 조각②(답변/작업전환
// 엔드포인트) PR에서 다시 추가한다 — 조각①은 행 액션 자체를 안 그린다.
export interface CommentsSectionProps {
  face: CommentsFace;
  displayTimezone: string;
  /** 수동 재수집(BE #3865 조각①). uncollected 포함 모든 얼굴에서 뜬다 — "아직
   * 수집 전"이어도 사람이 지금 바로 트리거할 수 있어야 한다(자동 수집을 기다리지
   * 않는다). onRefresh는 POST만 하고, 성공 뒤 목록을 다시 부르는 건 호출부(페이지)
   * 몫이다(이 컴포넌트는 재조회 트리거만 위임받는다). */
  onRefresh: () => Promise<CommentsRefreshOutcome>;
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
  comments, displayTimezone, t,
}: {
  comments: CommentItem[];
  displayTimezone: string;
  t: ReturnType<typeof useTranslations>;
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
            {/* story #3517(§22-9) — 지워진 댓글: 본문은 길이 무관 기본 접힘(forceCollapsed)
                + "원본이 지워졌습니다" 한 줄. text는 BE가 보존해서 준다(숨기지 않는다). */}
            <CommentBodyText
              text={comment.bodyText}
              moreLabel={t('commentsMoreLabel')}
              forceCollapsed={isDeleted}
              deletedSummaryLabel={t('commentsDeletedBodyLabel')}
            />
            {isDeleted ? (
              <p className="text-xs text-muted-foreground" data-testid="comments-item-deleted-note">
                {t('commentsDeletedNote')}
              </p>
            ) : null}
            {/* story #3517(PO 確定 2026-09-05, 조각①-FE 범위) — 행 액션(작업으로
                전환·답변)·답변 상태 칩은 이 슬라이스에서 렌더하지 않는다. 조각②
                (답변/작업전환 엔드포인트) 미착지 상태로 눌러도 아무 일도 안 나는
                컨트롤을 그리지 않는다("아직 없는 기능은 안 그린다"). 컴포넌트
                (CommentConvertToTaskDialog)·상태 칩(CommentReplyStatusChip)·테스트는
                남아 있다 — 조각② PR에서 이 자리에 다시 배선한다. */}
          </li>
        );
      })}
    </ul>
  );
}

export function CommentsSection({ face, displayTimezone, onRefresh }: CommentsSectionProps) {
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
        <CommentsRefreshButton onRefresh={onRefresh} />
        {/* story #3517(유나 Design 재리뷰, 2026-09-05) — active_count===0이어도
            지워진 행(deleted_count>0)은 §22-9 "원래 자리 그대로" 그린다 — "댓글
            없음" 문구가 지워진 행의 존재 자체를 지우면 안 된다. */}
        {face.comments.length > 0 ? <CommentsList comments={face.comments} displayTimezone={displayTimezone} t={t} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="comments-section">
      <SectionHeader t={t} activeCount={face.activeCount} deletedCount={face.deletedCount} capturedAtDisplay={capturedAtDisplay} />
      <CommentsRefreshButton onRefresh={onRefresh} />
      <CommentsList comments={face.comments} displayTimezone={displayTimezone} t={t} />
    </div>
  );
}
