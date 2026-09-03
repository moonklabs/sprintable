// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §4-1) — "S10의
// 오류 문구는 지어내지 않았다. 위 403 문구를 사람 말로 옮기고, 원문을 접어서 함께
// 보존한다 — 사람 말로만 바꿔 두면 gate_id를 잃어 추적이 끊긴다." 이 파일은 그 규율의
// 단일 구현처: 알려진 에러 코드만 사람 말로 매핑하고, 모를 땐 서버 원문을 그대로
// 보여준다(지어낸 문구로 덮지 않는다) — 그리고 어느 쪽이든 raw(코드+메시지 JSON)를
// 항상 같이 반환해 화면이 접어서 보존할 수 있게 한다.
//
// 페드루 PO 지시(2026-09-03, doc §8-3④-1) — 403/409를 하나의 "발행 오류" 문구로
// 뭉치지 않는다. 사람이 되돌릴 행동이 서로 다르기 때문이다:
//   ①승인 미완료(기다린다) ②발행 자격 없음(권한 요청) ③승인 뒤 본문 변경(재상신)
//   ④봉인 자체가 없음(재상신부터) ⑤재승인 대기 중 승인 시도(작성자의 재상신을 기다린다).
// `kind`가 그 다섯 갈래 + unknown과 화면(S9/S10)을 잇는다. post-status.ts::
// ContentPostBlockedReason은 이와 별개 축 — 그쪽은 "발행 시도 전 화면이 스스로 판단한
// 상태"이고, 여기는 "서버가 실제로 거부하며 돌려준 응답"이다(둘 다 SEAL_MISSING/
// HASH_MISMATCH 계열을 다루지만 시점과 출처가 다르다).
export type SitePostApiErrorKind =
  | 'approval_required'
  | 'permission'
  | 'reapproval_required'
  | 'seal_missing'
  | 'resubmit_required'
  | 'unknown';

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

// S3(story #3369, PR#3734) 착지 실물로 확인된 구조화 코드 — 발행 endpoint
// (POST .../drafts/{draft_id}/publish)가 실제로 이 셋을 {code,message} 구조로 낸다
// (site_posts.py::publish_site_post_from_draft·라우터의 except 매핑 그대로).
// SITE_POST_RESUBMIT_REQUIRED는 S2(gates.py 승인 전이 가드)가 내는 별도 코드 —
// 승인 화면(approvals-queue.tsx)이 reapproval_required 플래그로 이미 버튼을 막아 두므로
// 정상 경로로는 도달 드물지만(레이스 방어), 도달 시 "재상신을 기다려야 한다"는 이 발행
// 화면과 같은 문구를 쓴다.
const KNOWN_ERRORS: Record<string, KnownError> = {
  MEDIA_NOT_SUPPORTED_PHASE0: { labelKey: 'errorMediaNotSupported', kind: 'unknown' },
  SITE_POST_PUBLISH_HUMAN_ONLY: { labelKey: 'errorPublishHumanOnly', kind: 'permission' },
  EXTERNAL_PUBLISH_APPROVAL_REQUIRED: { labelKey: 'errorApprovalRequired', kind: 'approval_required' },
  SITE_POST_REAPPROVAL_REQUIRED: { labelKey: 'errorReapprovalRequired', kind: 'reapproval_required' },
  SITE_POST_SEAL_MISSING: { labelKey: 'errorSealMissing', kind: 'seal_missing' },
  SITE_POST_RESUBMIT_REQUIRED: { labelKey: 'errorResubmitRequired', kind: 'resubmit_required' },
  // story #3386 — 「발행 취소」 버튼이 부르는 story #3381(PR#3739, 이 브랜치 착수 시점
  // 미병합) 엔드포인트의 에러 코드. 병합 전엔 그 라우트 자체가 없어 404(pass-through
  // raw fallback으로 뜬다 — 다른 계약 stub 자리와 동형 관례, S2 착지 전 submit()과 동일).
  SITE_POST_UNPUBLISH_HUMAN_ONLY: { labelKey: 'errorUnpublishHumanOnly', kind: 'permission' },
  SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY: { labelKey: 'errorUnpublishOwnerOrAdminOnly', kind: 'permission' },
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
