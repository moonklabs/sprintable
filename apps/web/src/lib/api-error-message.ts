/**
 * story #2647(공통화, PO 재량 지시) — story #2637 §범위3의 EventPublishActionButton이 먼저
 * 세운 패턴("BE가 이유를 완성 문장으로 주므로 FE가 재구성하지 않고 그대로 보여준다")을
 * 여기로 뽑아 DeliveryContractModal(#2647)과 공유한다. BE 에러 응답은 두 모양이 섞여 있다
 * (apiSuccess()가 감싼 `{error:{message}}`·FastAPI HTTPException을 그대로 통과시키는
 * `{detail: string | {message: string}}`).
 *
 * story #3601(유나 Design CHANGES, 페드루 PO 정정 2026-09-07) — 「BE가 완성 문장을 준다」는
 * 원 전제가 깨졌다: 실측해 보니 몇몇 코드는 uuid·내부 필드/상태값·raw exception repr을
 * 그대로 담는다(예: `COMMENT_REPLY_WRONG_STATUS`의 "이 상태(draft)에서는…", `UNSUPPORTED_
 * CONTENT_TYPE`의 "…content_type: 'image/gif' (허용: […])"). §object 형(`error.message`·
 * `detail.message`) 자리만 `HUMAN_SAFE_ERROR_MESSAGE_CODES` 허용목록으로 gate한다 — 그
 * 코드가 목록에 있을 때만 원문을 그대로 보여주고, 없으면 null(호출부가 자기 폴백 문구로
 * 돌아간다, "예전 얼굴"). `detail`이 순수 문자열인 형(FastAPI 다른 라우트가 그대로 내는
 * 정책거부 사유 등, story #2647 DeliveryContractModal 계약)은 code 자체가 없어 안전성을
 * 잴 수 없으므로 이 gate 밖 — 기존 동작 그대로 무조건 통과(그 화면들의 계약을 이 스토리가
 * 건드리지 않는다).
 *
 * 새 코드를 이 목록에 추가하려면: 그 코드의 실제 BE 원문을 읽고(uuid·내부 이름·raw
 * exception repr 없음을 확認) PR 본문에 그 문장을 그대로 인용할 것 — "안전해 보인다"가
 * 아니라 "확認했다"가 등재 기준이다.
 */
export const HUMAN_SAFE_ERROR_MESSAGE_CODES = new Set<string>([
  // channel_post_comments.py::refresh_publication_comments_endpoint
  'COMMENT_REFRESH_HUMAN_ONLY', // "댓글 재수집은 휴먼 멤버만 가능합니다."
  'COMMENT_COLLECTION_UNSUPPORTED', // "이 채널은 댓글 수집을 지원하지 않습니다."
  'CHANNEL_CONNECTION_NOT_ACTIVE', // "연결에 자격이 없습니다."
  // channel_post_comment_replies.py
  'COMMENT_REPLY_HUMAN_ONLY', // "이 액션은 휴먼 멤버만 가능합니다."
  'COMMENT_REPLY_TARGET_DELETED', // "답변 대상 댓글이 삭제되어 상신할 수 없습니다."
  'COMMENT_REPLY_CHANNEL_UNSUPPORTED', // "이 채널은 답변 발송을 지원하지 않습니다."
  'COMMENT_REPLY_DRAFT_ALREADY_OPEN', // "안 보낸 초안이 이미 있습니다."
  // channel_posts.py::_require_human(발행류 공용, retry 엔드포인트도 공유)
  'CHANNEL_POST_PUBLISH_HUMAN_ONLY', // "채널 포스트 발행은 휴먼 멤버만 가능합니다(에이전트는 초안·상신까지)."
]);

export function extractBackendErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
  const errorCode = typeof b.error?.code === 'string' ? b.error.code : undefined;
  if (errorCode && HUMAN_SAFE_ERROR_MESSAGE_CODES.has(errorCode) && typeof b.error?.message === 'string') {
    return b.error.message;
  }
  // 순수 문자열 detail — code가 없어 이 gate 밖(위 docstring 참고, story #2647 계약 보존).
  if (typeof b.detail === 'string') return b.detail;
  if (b.detail && typeof b.detail === 'object') {
    const d = b.detail as { code?: unknown; message?: unknown };
    const detailCode = typeof d.code === 'string' ? d.code : undefined;
    if (detailCode && HUMAN_SAFE_ERROR_MESSAGE_CODES.has(detailCode) && typeof d.message === 'string') {
      return d.message;
    }
  }
  return null;
}
