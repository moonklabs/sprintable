// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §4-1) — "S10의
// 오류 문구는 지어내지 않았다. 위 403 문구를 사람 말로 옮기고, 원문을 접어서 함께
// 보존한다 — 사람 말로만 바꿔 두면 gate_id를 잃어 추적이 끊긴다." 이 파일은 그 규율의
// 단일 구현처: 알려진 에러 코드만 사람 말로 매핑하고, 모를 땐 서버 원문을 그대로
// 보여준다(지어낸 문구로 덮지 않는다) — 그리고 어느 쪽이든 raw(코드+메시지 JSON)를
// 항상 같이 반환해 화면이 접어서 보존할 수 있게 한다.
export interface SitePostApiErrorInfo {
  /** 사람이 읽을 문장. 알려진 코드면 번역 키, 모르면 서버 원문 메시지 그대로. */
  humanMessageKey?: string;
  humanMessageFallback: string;
  /** gate_id 등 추적 정보를 잃지 않도록 항상 보존하는 원문(code+message JSON 문자열). */
  raw: string;
}

// 오늘(S4 편집·상신 슬라이스) 시점에 실제로 만날 수 있는 코드만 등재한다 — 아직 착지 전인
// S2·S3의 에러 코드(SITE_POST_REAPPROVAL_REQUIRED·EXTERNAL_PUBLISH_APPROVAL_REQUIRED 등)는
// 그 스토리가 착지할 때 실물 계약과 대조해 추가한다(지금 지어내지 않는다).
const KNOWN_ERROR_LABEL_KEYS: Record<string, string> = {
  MEDIA_NOT_SUPPORTED_PHASE0: 'errorMediaNotSupported',
  SITE_POST_PUBLISH_HUMAN_ONLY: 'errorPublishHumanOnly',
};

function extractCodeAndMessage(detail: unknown): { code?: string; message?: string } {
  if (typeof detail === 'string') return { message: detail };
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: unknown; message?: unknown };
    return {
      code: typeof d.code === 'string' ? d.code : undefined,
      message: typeof d.message === 'string' ? d.message : undefined,
    };
  }
  return {};
}

/**
 * body는 프록시가 그대로 pass-through한 백엔드 에러 body(대개 FastAPI HTTPException의
 * `{"detail": ...}` 형상, 우리 자체 라우트의 `{error:{message}}` 형상도 방어).
 */
export function parseSitePostApiError(
  body: { detail?: unknown; error?: { code?: string; message?: string } } | null,
): SitePostApiErrorInfo {
  const fromDetail = extractCodeAndMessage(body?.detail);
  const code = fromDetail.code ?? body?.error?.code;
  const message = fromDetail.message ?? body?.error?.message;
  const raw = JSON.stringify({ code: code ?? null, message: message ?? null });

  const humanMessageKey = code ? KNOWN_ERROR_LABEL_KEYS[code] : undefined;
  return {
    humanMessageKey,
    humanMessageFallback: message ?? '',
    raw,
  };
}
