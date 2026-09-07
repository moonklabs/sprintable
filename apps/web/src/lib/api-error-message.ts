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
 * 돌아간다, "예전 얼굴"). `detail`이 순수 문자열인 형은 code 자체가 없어 안전성을 잴 수
 * 없으므로 이 gate 밖 — 기존 동작 그대로 무조건 통과시킨다. 페드루 PO 정정(2026-09-07)
 * — 이 형이 "다른 라우트가 실제로 내는 합법적 shape"라는 건 부정확하다: 우리 BE 전역
 * 핸들러는 string detail로 raise된 HTTPException도 object(`error:{code,message}`)로
 * 감싼다(lint_fe_error_envelope_detail_mismatch.py 참고) — 우리 BE가 실제로 내는 string
 * detail은 없다(Pydantic 422조차 object가 아니라 `[{loc,msg,type}]` 배열이라 이 분기와
 * 무관). 이 분기는 순수하게 `DeliveryContractModal.test.tsx`(#2647)의 옛 픽스처 계약을
 * 깨지 않으려는 하위호환일 뿐 — 실 BE 오늘 산출물이 아니다.
 *
 * 새 코드를 이 목록에 추가하려면: **그 code로 raise하는 자리를 저장소 전체에서 grep해
 * 전수**를 세고, 그 전부의 원문을 읽어(uuid·내부 이름·raw exception repr 없음을 확認)
 * 하나도 빠짐없이 사람 문장일 때만 등재한다. 한 자리만 확認하고 "한 자리로 보인다"로
 * 등재하지 않는다 — 페드루 PO 정정(2026-09-07): `CHANNEL_CONNECTION_NOT_ACTIVE`가 실제
 * 반례다. 이 code로 raise하는 자리가 저장소에 20곳 넘게 있고 그중 다수(site_posts.py·
 * insight_snapshots.py·publication_command.py 등)가 `f"...{connection.id}"`처럼 uuid를
 * 그대로 담는다 — 한 자리(channel_post_comments.py의 fetch 공용 블록)만 보고 "댓글 수집
 * 흐름의 이 code는 안전하다"로 처음 등재했던 게 오판이었다. PR 본문에 코드마다 「raise
 * 자리 수 → 문장 전부」를 표로 남길 것 — "안전해 보인다"가 아니라 "전수 확認했다"가
 * 등재 기준이다.
 *
 * story #3615(BE·계약, 페드루 PO 確定 2026-09-07) — 이 allowlist는 "FE가 코드별로
 * 안전한지 암기"하는 구조라 코드가 늘 때마다(#3605 CHANGES-3처럼) FE도 손으로 따라
 * 고쳐야 했다. 이 계약이 그 판별을 BE로 옮긴다 — `error.user_message`(BE가 직접 쓴,
 * 사람에게 그대로 보여도 되는 문장)·`error.user_message_key`(FE i18n 키)가 있으면
 * **allowlist 조회 없이** 그걸 최우선으로 쓴다(`human_error()`로 채운 자리부터 점진
 * 전환, `app/core/error_envelope.py` 참고). 아래 allowlist는 아직 human_error()로
 * 전환 안 된 자리들의 안전망으로 당분간 남는다 — 전환이 끝나(등재 0건 수렴) 이 파일
 * 자체와 `lint_fe_error_envelope_detail_mismatch.py`를 은퇴시키는 게 이 스토리가 연
 * 길이다(이 PR에서 즉시 은퇴는 아님 — AC3, "수렴 가능함을 보인다"까지).
 */
export const HUMAN_SAFE_ERROR_MESSAGE_CODES = new Set<string>([
  // channel_post_comments.py::refresh_publication_comments_endpoint(raise 1곳)
  'COMMENT_REFRESH_HUMAN_ONLY', // "댓글 재수집은 휴먼 멤버만 가능합니다."
  'COMMENT_COLLECTION_UNSUPPORTED', // "이 채널은 댓글 수집을 지원하지 않습니다."(raise 1곳)
  // channel_post_comment_replies.py·gates.py
  'COMMENT_REPLY_HUMAN_ONLY', // "이 액션은 휴먼 멤버만 가능합니다."(raise 1곳)
  'COMMENT_REPLY_TARGET_DELETED', // raise 2곳 — "답변 대상 댓글이 삭제되어 상신할 수 없습니다."(replies.py) · "…승인할 수 없습니다."(gates.py) 둘 다 안전
  'COMMENT_REPLY_CHANNEL_UNSUPPORTED', // "이 채널은 답변 발송을 지원하지 않습니다."(raise 1곳)
  'COMMENT_REPLY_DRAFT_ALREADY_OPEN', // "안 보낸 초안이 이미 있습니다."(raise 1곳)
  // channel_posts.py::_require_human(발행류 공용, retry 엔드포인트도 공유, raise 1곳)
  'CHANNEL_POST_PUBLISH_HUMAN_ONLY', // "채널 포스트 발행은 휴먼 멤버만 가능합니다(에이전트는 초안·상신까지)."
  // ⛔ CHANNEL_CONNECTION_NOT_ACTIVE는 raise 20곳+(site_posts.py·insight_snapshots.py·
  // publication_command.py·channel_posts.py·channel_post_comments.py 등) — 그중 다수가
  // uuid(connection.id·publication_id)를 그대로 담아 등재 금지(2026-09-07 정정, 페드루 PO).
]);

interface ErrorLikeShape {
  code?: unknown;
  message?: unknown;
  user_message?: unknown;
  user_message_key?: unknown;
}

/**
 * story #3615 — BE `human_error()` 계약(있으면 allowlist 조회 없이 최우선): (1)
 * `user_message_key`가 있고 `t`가 주어졌으면 그 키로 렌더 (2) `user_message`가 있으면
 * 그대로 (3) 둘 다 없으면 `null`(호출부가 코드별 generic 폴백으로 — 이 함수의 기존
 * allowlist 분기로 계속 넘어간다).
 */
function resolveContractMessage(shape: ErrorLikeShape, t?: (key: string) => string): string | null {
  const key = typeof shape.user_message_key === 'string' ? shape.user_message_key : undefined;
  if (key && t) return t(key);
  const userMessage = typeof shape.user_message === 'string' ? shape.user_message : undefined;
  if (userMessage) return userMessage;
  return null;
}

/**
 * `t`는 선택 — next-intl `useTranslations()`의 반환값(또는 동형 `(key: string) =>
 * string`)을 넘기면 `user_message_key` 자리도 렌더된다. 생략하면 그 자리는 건너뛰고
 * `user_message`→allowlist 순으로 그대로 진행(회귀 0, 기존 4개 호출부가 당장 안 바꿔도
 * 깨지지 않는다).
 */
export function extractBackendErrorMessage(body: unknown, t?: (key: string) => string): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: ErrorLikeShape; detail?: unknown };

  if (b.error && typeof b.error === 'object') {
    const fromContract = resolveContractMessage(b.error, t);
    if (fromContract) return fromContract;
  }
  const errorCode = typeof b.error?.code === 'string' ? b.error.code : undefined;
  if (errorCode && HUMAN_SAFE_ERROR_MESSAGE_CODES.has(errorCode) && typeof b.error?.message === 'string') {
    return b.error.message;
  }
  // 순수 문자열 detail — code가 없어 이 gate 밖(위 docstring 참고, story #2647 계약 보존).
  if (typeof b.detail === 'string') return b.detail;
  if (b.detail && typeof b.detail === 'object') {
    const d = b.detail as ErrorLikeShape;
    const fromContractDetail = resolveContractMessage(d, t);
    if (fromContractDetail) return fromContractDetail;
    const detailCode = typeof d.code === 'string' ? d.code : undefined;
    if (detailCode && HUMAN_SAFE_ERROR_MESSAGE_CODES.has(detailCode) && typeof d.message === 'string') {
      return d.message;
    }
  }
  return null;
}
