// story #3503 — content/api-error.ts는 "site post" API 전용으로 명시적으로 스코프된
// 모듈이라(SitePostApiErrorKind 유니온) 여기 새 코드를 얹지 않는다(PO 브리프 명시). 대신
// 이 기능 전용 작은 형제 파일 — 같은 「사람 말+원문 보존」 관례(raw는 항상 채운다, 모르는
// 코드는 지어내지 않고 서버 원문을 그대로 보여준다)만 최소 형태로 복제.
export type InsightsBoardErrorKind =
  | 'invalid_window'
  | 'invalid_sort'
  | 'follow_up_human_only'
  | 'follow_up_invalid_kind'
  | 'unknown';

export interface InsightsBoardErrorInfo {
  /** 사람이 읽을 문장. 알려진 코드면 번역 키, 모르면(또는 code 자체가 없으면) 서버 원문. */
  humanMessageKey?: string;
  humanMessageFallback: string;
  /** 항상 채운다 — {code, message} JSON 문자열(디버깅 보존). */
  raw: string;
  kind: InsightsBoardErrorKind;
}

interface KnownError {
  labelKey: string;
  kind: InsightsBoardErrorKind;
}

// BE #3502(fd57310d4, origin/feat/3502-insights-board-api, 아직 develop 미착지) 계약
// 그대로 — insights_board.py/follow-up 라우터가 내는 구조화 코드 4종.
const KNOWN_ERRORS: Record<string, KnownError> = {
  INSIGHTS_BOARD_INVALID_WINDOW: { labelKey: 'errorInvalidWindow', kind: 'invalid_window' },
  INSIGHTS_BOARD_INVALID_SORT: { labelKey: 'errorInvalidSort', kind: 'invalid_sort' },
  // 사람 전용 액션 — BE가 에이전트를 통째로 막는다(403). 화면은 가능하면 버튼 자체를
  // 숨기지만(currentMemberType==='agent'), 레이스·구버전 화면 등 방어적으로 이 코드가
  // 그대로 뜰 수 있어 문구도 준비해 둔다.
  FOLLOW_UP_CREATE_HUMAN_ONLY: { labelKey: 'errorFollowUpHumanOnly', kind: 'follow_up_human_only' },
  FOLLOW_UP_INVALID_KIND: { labelKey: 'errorFollowUpInvalidKind', kind: 'follow_up_invalid_kind' },
};

function extractCodeAndMessage(detail: unknown): { code?: string; message?: string } {
  // 404 publication 없음 · 403 org_id mismatch는 code 필드가 아예 없는 순문자열 detail
  // (브리프 명시) — 이 분기가 그 케이스를 흡수해 humanMessageFallback으로 그대로 보존한다.
  if (typeof detail === 'string') return { message: detail };
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    return {
      code: typeof d.code === 'string' ? d.code : undefined,
      message: typeof d.message === 'string' ? d.message : undefined,
    };
  }
  return {};
}

/**
 * body는 BFF가 그대로 pass-through한 백엔드 에러 body — FastAPI raw `{"detail": ...}` 형상
 * (구조화 코드는 `{"detail": {"code": "...", "message": "..."}}`, 플레인 404/403은
 * `{"detail": "publication을 찾을 수 없습니다: ..."}`류)과, main.py http_exception_handler
 * 경유 시의 `{"error": {"code": ..., "message": ...}}` 형상 둘 다 방어적으로 읽는다
 * (parseSitePostApiError와 동일 규율).
 */
export function parseInsightsBoardApiError(
  body: { detail?: unknown; error?: Record<string, unknown> } | null,
): InsightsBoardErrorInfo {
  const fromDetail = extractCodeAndMessage(body?.detail);
  const fromError = extractCodeAndMessage(body?.error);
  const code = fromDetail.code ?? fromError.code;
  const message = fromDetail.message ?? fromError.message;
  const raw = JSON.stringify({ code: code ?? null, message: message ?? null });

  const known = code ? KNOWN_ERRORS[code] : undefined;
  return {
    humanMessageKey: known?.labelKey || undefined,
    humanMessageFallback: message ?? '',
    raw,
    kind: known?.kind ?? 'unknown',
  };
}
