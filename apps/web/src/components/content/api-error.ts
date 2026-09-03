// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §4-1) — "S10의
// 오류 문구는 지어내지 않았다. 위 403 문구를 사람 말로 옮기고, 원문을 접어서 함께
// 보존한다 — 사람 말로만 바꿔 두면 gate_id를 잃어 추적이 끊긴다." 이 파일은 그 규율의
// 단일 구현처: 알려진 에러 코드만 사람 말로 매핑하고, 모를 땐 서버 원문을 그대로
// 보여준다(지어낸 문구로 덮지 않는다) — 그리고 어느 쪽이든 raw(코드+메시지 JSON)를
// 항상 같이 반환해 화면이 접어서 보존할 수 있게 한다.
//
// 페드루 PO 지시(2026-09-03, doc §8-3④-1) — 403/409를 하나의 "발행 오류" 문구로
// 뭉치지 않는다. 사람이 되돌릴 행동이 서로 다르기 때문이다:
//   ①승인 미완료(기다린다) ②발행 자격 없음(권한 요청) ③승인 뒤 본문 변경(재상신).
// `kind`가 그 세 갈래 + SEAL_MISSING(서버 응답이 아니라 클라이언트 판정,
// post-status.ts::ContentPostBlockedReason이 이미 그 자리를 진다 — 이 파일은 서버가
// 실제로 돌려준 에러만 다룬다)와 화면(S9/S10)을 잇는다.
export type SitePostApiErrorKind = 'approval_required' | 'permission' | 'reapproval_required' | 'unknown';

export interface SitePostApiErrorInfo {
  /** 사람이 읽을 문장. 알려진 코드면 번역 키, 모르면 서버 원문 메시지 그대로. */
  humanMessageKey?: string;
  humanMessageFallback: string;
  /** gate_id 등 추적 정보를 잃지 않도록 항상 보존하는 원문(code+message JSON 문자열). */
  raw: string;
  /** 화면이 어느 처리로 갈지(S9 재승인 배너 재사용 vs S10 일반 오류) — §8-3④-1. */
  kind: SitePostApiErrorKind;
}

interface KnownError {
  labelKey: string;
  kind: SitePostApiErrorKind;
}

// 오늘(S4 편집·상신·발행 슬라이스) 시점에 실제로 만날 수 있는 코드만 "라이브"로 등재한다.
// EXTERNAL_PUBLISH_APPROVAL_REQUIRED·SITE_POST_REAPPROVAL_REQUIRED 둘은 아직 서버가
// 구조화 code로 안 낸다(오늘은 detail이 평문 문자열 — `site_posts.py::
// ExternalPublishGateNotApprovedError`를 `str(exc)`로 감싼다, code 필드 자체가 없다).
// 페드루 PO가 지정한 미래 계약(S3 착지 예정)을 여기 미리 등재해 둔다 — 코드가 도착하면
// 이 표만 그대로 걸리고, 그 전에는 code 없는 문자열이라 그냥 "모름"(raw fallback)으로
// 안전하게 떨어진다(지어낸 성공 0, 지어낸 매핑도 0).
const KNOWN_ERRORS: Record<string, KnownError> = {
  MEDIA_NOT_SUPPORTED_PHASE0: { labelKey: 'errorMediaNotSupported', kind: 'unknown' },
  SITE_POST_PUBLISH_HUMAN_ONLY: { labelKey: 'errorPublishHumanOnly', kind: 'permission' },
  // TODO(S3 착지 후): 서버가 이 code를 구조화해 내면(지금은 평문 메시지만) 실물과
  // 대조해 라벨을 재확인한다 — 지금은 페드루 PO 지정 계약을 앞서 배선만 해 둔다.
  EXTERNAL_PUBLISH_APPROVAL_REQUIRED: { labelKey: 'errorApprovalRequired', kind: 'approval_required' },
  SITE_POST_REAPPROVAL_REQUIRED: { labelKey: 'errorReapprovalRequired', kind: 'reapproval_required' },
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

  const known = code ? KNOWN_ERRORS[code] : undefined;
  return {
    humanMessageKey: known?.labelKey,
    humanMessageFallback: message ?? '',
    raw,
    kind: known?.kind ?? 'unknown',
  };
}
