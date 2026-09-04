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
// story #3402(Phase1·마케팅운영, 유나 doc §5 v8 정본) — 채널 포스트 화면(§5 표 12행)이
// 이 파일을 그대로 재사용한다(site와 별도 파일을 만들면 두 벌이 된다). 새 갈래 일곱 —
// ⑥한도 초과(대기/예약) ⑦연결 끊김(재연결) ⑧연결 비활성(연결화면 확認) ⑨승인자 미지정
// (역할 배정) ⑩경합 처리 중(재확認) ⑪글자수 초과(줄여서 재상신) ⑫provider 원문 실패
// (접어서 보존). gate_already_held는 site와 kind를 공유하되(같은 UI 분기 — "그 초안 보기"
// 하나만) 채널 쪽은 다른 부가 필드(holding_channel·holding_connection_id, slug/lang 없음
// — 채널 포스트 모델 자체에 title이 없다, doc §5 각주)를 싣는다.
export type SitePostApiErrorKind =
  | 'approval_required'
  | 'permission'
  | 'reapproval_required'
  | 'seal_missing'
  | 'resubmit_required'
  | 'gate_already_held'
  | 'rate_limited'
  | 'token_expired'
  | 'connection_not_active'
  | 'approver_role_missing'
  | 'publish_in_progress'
  | 'text_too_long'
  | 'provider_error'
  // story #3426(BE #3419) — 예약 취소·회수 전용 신규 kind 2개.
  | 'command_not_cancellable'
  | 'command_not_found'
  | 'not_published'
  | 'unpublish_unsupported'
  | 'scope_insufficient'
  // story #3428(BE 620beefc·PR#3776, §13/§17-16) — 채널 포스트 이미지 첨부 9갈래. 정확
  // 일치(===)로만 KNOWN_ERRORS를 조회한다 — CHANNEL_IMAGE_UNSUPPORTED ⊂
  // CHANNEL_IMAGE_UNSUPPORTED_FORMAT 접두 관계라 문자열 부분일치 판정을 쓰면 오매핑된다.
  | 'image_storage_not_configured'
  | 'image_unsupported'
  | 'image_unsupported_format'
  | 'image_too_large'
  | 'image_undecodable'
  | 'image_animated_unsupported'
  | 'image_aspect_ratio_exceeded'
  | 'image_conversion_failed'
  | 'image_upload_failed'
  | 'unknown';

export interface SitePostApiErrorInfo {
  /** 사람이 읽을 문장. 알려진 코드면 번역 키, 모르면 서버 원문 메시지 그대로. */
  humanMessageKey?: string;
  humanMessageFallback: string;
  /** gate_id 등 추적 정보를 잃지 않도록 항상 보존하는 원문(code+message JSON 문자열). */
  raw: string;
  /** 화면이 어느 처리로 갈지(S9 재승인 배너 재사용 vs S10 일반 오류) — §8-3④-1. */
  kind: SitePostApiErrorKind;
  // story f6d14476 AC3 — SITE_POST_GATE_ALREADY_HELD가 실어 오는, 게이트를 쥔 상대 초안
  // 식별자. 서버는 title을 안 준다(neutral_facts엔 title이 없다) — 화면이 이 draft_id로
  // 별도 조회해 제목을 채운다(§8-1의 "지어내지 않는다" 규율 — id 그대로 노출 대신).
  heldByDraftId?: string;
  heldByLang?: string | null;
  heldBySlug?: string;
  // story #3402·PR#3764 c6049add1 — CHANNEL_POST_GATE_ALREADY_HELD 전용. site와 달리
  // slug/lang이 없다(채널 포스트 모델엔 title 자체가 없다) — 대신 채널·연결 식별자로
  // "Threads 초안 ····a1b2" 폴백 문구를 조립한다(doc §5 각주, 전체 UUID는 화면에 안 남김).
  heldByChannel?: string;
  heldByConnectionId?: string;
  /** CHANNEL_RATE_LIMITED(429) 전용 — "내일 09:00 이후 가능합니다" 조립·예약 기본값. */
  resetAt?: string;
  /** CHANNEL_TEXT_TOO_LONG(422) 전용 — "500자 한도인데 517자입니다" 조립. */
  maxLength?: number;
  currentLength?: number;
  /** PUBLICATION_COMMAND_NOT_CANCELLABLE(409) 전용 — "이미 {current_status} 상태입니다" 조립. */
  currentStatus?: string;
  // story #3428 — CHANNEL_IMAGE_* 9종 전용 부가 필드(§13 3요소: 무엇이·얼마까지·지금
  // 얼마). 코드마다 실리는 부분집합이 다르다(예: UNDECODABLE은 전부 undefined) — page.tsx가
  // kind로 분기해 있는 값만 보간한다.
  imageChannel?: string;
  imageContentType?: string;
  imageAllowedFormats?: string[];
  imageSizeBytes?: number;
  imageMaxBytes?: number;
  imageFrameCount?: number;
  imageAspectRatio?: number;
  imageMaxAspectRatio?: number;
  imageFinalBytes?: number;
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
  // story f6d14476(AC1·AC3) — 같은 work_item의 다른 초안이 이미 게이트를 쥐고 있어 상신이
  // 막힘(submit endpoint 전용). labelKey는 일부러 비운다 — 이 문구는 {title}·{lang} 보간이
  // 필요한데 title은 서버가 안 준다(heldByDraftId로 화면이 별도 조회해 채운 뒤에야 완성
  // 가능) — 그래서 kind로만 분기하고 실제 문구 조립은 page.tsx가 한다.
  SITE_POST_GATE_ALREADY_HELD: { labelKey: '', kind: 'gate_already_held' },

  // story #3402(Phase1·마케팅운영, 유나 doc §5 v8 정본) — 채널 포스트 화면 12행. HTTP
  // status·「사람 말」·「다음 행동」은 그 표가 정본(구현: channel_posts.py 라우터
  // except 매핑, PR#3752 277debe92·#3757 eb55c4221·#3395·PR#3764 c6049add1 실측).
  CHANNEL_RATE_LIMITED: { labelKey: 'errorChannelRateLimited', kind: 'rate_limited' },
  CHANNEL_TOKEN_EXPIRED: { labelKey: 'errorChannelTokenExpired', kind: 'token_expired' },
  CHANNEL_CONNECTION_NOT_ACTIVE: { labelKey: 'errorChannelConnectionNotActive', kind: 'connection_not_active' },
  CHANNEL_POST_APPROVER_ROLE_MISSING: { labelKey: 'errorChannelApproverRoleMissing', kind: 'approver_role_missing' },
  // doc §5 v8 — 발행은 사람이 화면에서 한다. 에이전트에겐 이 화면 자체가 없어(AC14)
  // 정상 경로로 이 화면에 뜨지 않지만, 매핑표는 하나여야 하므로 등록해 둔다.
  CHANNEL_POST_PUBLISH_HUMAN_ONLY: { labelKey: 'errorChannelPublishHumanOnly', kind: 'permission' },
  // story #3395 — 동시 발행 요청 경합에서 진 쪽이 받는 응답. "다시 발행"이 아니라
  // "상태를 다시 확認"이 맞는 다음 행동이다(두 번째 요청이 새 게시를 만들지 않는다).
  CHANNEL_PUBLISH_IN_PROGRESS: { labelKey: 'errorChannelPublishInProgress', kind: 'publish_in_progress' },
  CHANNEL_TEXT_TOO_LONG: { labelKey: '', kind: 'text_too_long' }, // maxLength·currentLength로 문구 조립(labelKey는 page.tsx가 보간)
  // EXTERNAL_PUBLISH_APPROVAL_REQUIRED·SITE_POST_SEAL_MISSING·SITE_POST_REAPPROVAL_REQUIRED
  // 는 위 site 항목을 그대로 재사용한다(같은 external_publish 게이트 개념 공유, doc §9-4).
  // story #3402·PR#3764 — 채널 포스트 전용 GATE_ALREADY_HELD. site와 kind는 같지만
  // (같은 "그 초안 보기" 분기) 부가 필드가 다르다(slug/lang 없음 — 채널 포스트 모델 자체에
  // title이 없다). labelKey는 site와 동일하게 비워 page.tsx가 heldByChannel/
  // heldByConnectionId로 폴백 문구를 조립한다.
  CHANNEL_POST_GATE_ALREADY_HELD: { labelKey: '', kind: 'gate_already_held' },
  CHANNEL_PUBLISH_PROVIDER_ERROR: { labelKey: 'errorChannelPublishProviderError', kind: 'provider_error' },
  // story #3426(BE #3419, PR#3774) — 예약 취소·회수 6종(그라운딩 확認·2026-09-04 07:5x).
  // CANCEL_UNPUBLISH_HUMAN_ONLY/OWNER_OR_ADMIN_ONLY는 site-posts의 UNPUBLISH_* 항목을
  // 그대로 재사용한다(같은 "발행 취소·회수는 이 역할만" 개념 공유, 문구도 동일).
  CHANNEL_POST_CANCEL_UNPUBLISH_HUMAN_ONLY: { labelKey: 'errorUnpublishHumanOnly', kind: 'permission' },
  CHANNEL_POST_CANCEL_UNPUBLISH_OWNER_OR_ADMIN_ONLY: { labelKey: 'errorUnpublishOwnerOrAdminOnly', kind: 'permission' },
  PUBLICATION_COMMAND_NOT_FOUND: { labelKey: 'errorPublicationCommandNotFound', kind: 'command_not_found' },
  // current_status로 "이미 {status} 상태입니다"를 조립(labelKey는 page.tsx가 보간).
  PUBLICATION_COMMAND_NOT_CANCELLABLE: { labelKey: '', kind: 'command_not_cancellable' },
  CHANNEL_POST_NOT_PUBLISHED: { labelKey: 'errorChannelPostNotPublished', kind: 'not_published' },
  CHANNEL_UNPUBLISH_UNSUPPORTED: { labelKey: 'errorChannelUnpublishUnsupported', kind: 'unpublish_unsupported' },
  // scope_insufficient는 편집 화면이 이미 connection 응답의 unpublish_blocked_reason으로
  // role별 §17-11 정본 문구를 미리 보여 준다(버튼을 disabled로 막는 경로) — 이 코드는 그
  // 사이 스코프가 바뀌는 레이스 등 방어적 경로다. 같은 §17-11 개념이라 site의 role 분기
  // 문구를 그대로 재사용(labelKey는 비워 두고 page.tsx가 role로 갈라 조립).
  CHANNEL_SCOPE_INSUFFICIENT: { labelKey: '', kind: 'scope_insufficient' },

  // story #3428(BE 620beefc·PR#3776, §13/§17-16 — channel_posts.py assets/upload-url·
  // assets/confirm 실측). 채널 미지원(사용자가 못 바꾸는 어댑터 성질)과 파일 문제(파일을
  // 바꾸면 풀리는 것)를 다른 kind·다른 문장으로 가른다. 3요소(무엇이·얼마까지·지금 얼마)가
  // 필요한 코드는 labelKey를 비우고 page.tsx가 imageXxx 필드로 보간한다.
  CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED: { labelKey: 'errorChannelImageStorageNotConfigured', kind: 'image_storage_not_configured' },
  CHANNEL_IMAGE_UNSUPPORTED: { labelKey: 'errorChannelImageUnsupported', kind: 'image_unsupported' },
  CHANNEL_IMAGE_UNSUPPORTED_FORMAT: { labelKey: '', kind: 'image_unsupported_format' },
  CHANNEL_IMAGE_TOO_LARGE: { labelKey: '', kind: 'image_too_large' },
  CHANNEL_IMAGE_UNDECODABLE: { labelKey: 'errorChannelImageUndecodable', kind: 'image_undecodable' },
  CHANNEL_IMAGE_ANIMATED_UNSUPPORTED: { labelKey: '', kind: 'image_animated_unsupported' },
  CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED: { labelKey: '', kind: 'image_aspect_ratio_exceeded' },
  CHANNEL_IMAGE_CONVERSION_FAILED: { labelKey: '', kind: 'image_conversion_failed' },
  CHANNEL_IMAGE_UPLOAD_FAILED: { labelKey: 'errorChannelImageUploadFailed', kind: 'image_upload_failed' },
};

function extractCodeAndMessage(detail: unknown): {
  code?: string; message?: string;
  heldByDraftId?: string; heldByLang?: string | null; heldBySlug?: string;
  heldByChannel?: string; heldByConnectionId?: string;
  resetAt?: string; maxLength?: number; currentLength?: number; currentStatus?: string;
  imageChannel?: string; imageContentType?: string; imageAllowedFormats?: string[];
  imageSizeBytes?: number; imageMaxBytes?: number; imageFrameCount?: number;
  imageAspectRatio?: number; imageMaxAspectRatio?: number; imageFinalBytes?: number;
} {
  if (typeof detail === 'string') return { message: detail };
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    return {
      code: typeof d.code === 'string' ? d.code : undefined,
      message: typeof d.message === 'string' ? d.message : undefined,
      // story f6d14476 — SITE_POST_GATE_ALREADY_HELD 전용 부가 필드. 다른 코드엔 이 키들이
      // 없어 전부 undefined로 조용히 빠진다(다른 에러 처리 경로엔 영향 없음).
      heldByDraftId: typeof d.holding_draft_id === 'string' ? d.holding_draft_id : undefined,
      heldByLang: typeof d.holding_lang === 'string' || d.holding_lang === null ? (d.holding_lang as string | null) : undefined,
      heldBySlug: typeof d.holding_slug === 'string' ? d.holding_slug : undefined,
      // story #3402·PR#3764 — CHANNEL_POST_GATE_ALREADY_HELD 전용(slug/lang 대신).
      heldByChannel: typeof d.holding_channel === 'string' ? d.holding_channel : undefined,
      heldByConnectionId: typeof d.holding_connection_id === 'string' ? d.holding_connection_id : undefined,
      // story #3402 — CHANNEL_RATE_LIMITED 전용.
      resetAt: typeof d.reset_at === 'string' ? d.reset_at : undefined,
      // story #3402 — CHANNEL_TEXT_TOO_LONG 전용.
      maxLength: typeof d.max_length === 'number' ? d.max_length : undefined,
      currentLength: typeof d.current_length === 'number' ? d.current_length : undefined,
      // story #3426 — PUBLICATION_COMMAND_NOT_CANCELLABLE 전용.
      currentStatus: typeof d.current_status === 'string' ? d.current_status : undefined,
      // story #3428 — CHANNEL_IMAGE_* 9종 전용(channel_posts.py 라우터 except 매핑 실측
      // 그대로, 코드마다 실리는 부분집합이 다르다).
      imageChannel: typeof d.channel === 'string' ? d.channel : undefined,
      imageContentType: typeof d.content_type === 'string' ? d.content_type : undefined,
      imageAllowedFormats: Array.isArray(d.allowed_formats) ? (d.allowed_formats as string[]) : undefined,
      imageSizeBytes: typeof d.size_bytes === 'number' ? d.size_bytes : undefined,
      imageMaxBytes: typeof d.max_bytes === 'number' ? d.max_bytes : undefined,
      imageFrameCount: typeof d.frame_count === 'number' ? d.frame_count : undefined,
      imageAspectRatio: typeof d.aspect_ratio === 'number' ? d.aspect_ratio : undefined,
      imageMaxAspectRatio: typeof d.max_aspect_ratio === 'number' ? d.max_aspect_ratio : undefined,
      imageFinalBytes: typeof d.final_bytes === 'number' ? d.final_bytes : undefined,
    };
  }
  return {};
}

/**
 * body는 프록시가 그대로 pass-through한 백엔드 에러 body(대개 FastAPI HTTPException의
 * `{"detail": ...}` 형상, 우리 자체 라우트의 `{error:{message}}` 형상도 방어).
 */
export function parseSitePostApiError(
  body: { detail?: unknown; error?: Record<string, unknown> } | null,
): SitePostApiErrorInfo {
  // main.py::http_exception_handler의 실제 응답 봉투는 {"data":null,"error":{code,message,
  // ...},"meta":null}다 — "detail"이 아니라 "error" 쪽이 실물이다. FastAPI raw shape
  // ({"detail":...})도 방어적으로 함께 읽는다(프록시 경유 등 다른 경로 대비, 회귀 0).
  const fromDetail = extractCodeAndMessage(body?.detail);
  const fromError = extractCodeAndMessage(body?.error);
  const code = fromDetail.code ?? fromError.code;
  const message = fromDetail.message ?? fromError.message;
  const heldByDraftId = fromDetail.heldByDraftId ?? fromError.heldByDraftId;
  const heldByLang = fromDetail.heldByLang ?? fromError.heldByLang;
  const heldBySlug = fromDetail.heldBySlug ?? fromError.heldBySlug;
  const heldByChannel = fromDetail.heldByChannel ?? fromError.heldByChannel;
  const heldByConnectionId = fromDetail.heldByConnectionId ?? fromError.heldByConnectionId;
  const resetAt = fromDetail.resetAt ?? fromError.resetAt;
  const maxLength = fromDetail.maxLength ?? fromError.maxLength;
  const currentLength = fromDetail.currentLength ?? fromError.currentLength;
  const currentStatus = fromDetail.currentStatus ?? fromError.currentStatus;
  const imageChannel = fromDetail.imageChannel ?? fromError.imageChannel;
  const imageContentType = fromDetail.imageContentType ?? fromError.imageContentType;
  const imageAllowedFormats = fromDetail.imageAllowedFormats ?? fromError.imageAllowedFormats;
  const imageSizeBytes = fromDetail.imageSizeBytes ?? fromError.imageSizeBytes;
  const imageMaxBytes = fromDetail.imageMaxBytes ?? fromError.imageMaxBytes;
  const imageFrameCount = fromDetail.imageFrameCount ?? fromError.imageFrameCount;
  const imageAspectRatio = fromDetail.imageAspectRatio ?? fromError.imageAspectRatio;
  const imageMaxAspectRatio = fromDetail.imageMaxAspectRatio ?? fromError.imageMaxAspectRatio;
  const imageFinalBytes = fromDetail.imageFinalBytes ?? fromError.imageFinalBytes;
  const raw = JSON.stringify({ code: code ?? null, message: message ?? null });

  const known = code ? KNOWN_ERRORS[code] : undefined;
  return {
    humanMessageKey: known?.labelKey || undefined,
    humanMessageFallback: message ?? '',
    raw,
    kind: known?.kind ?? 'unknown',
    heldByDraftId,
    heldByLang,
    heldBySlug,
    heldByChannel,
    heldByConnectionId,
    resetAt,
    maxLength,
    currentLength,
    currentStatus,
    imageChannel,
    imageContentType,
    imageAllowedFormats,
    imageSizeBytes,
    imageMaxBytes,
    imageFrameCount,
    imageAspectRatio,
    imageMaxAspectRatio,
    imageFinalBytes,
  };
}
