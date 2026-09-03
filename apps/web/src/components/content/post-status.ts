// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §3-1) — 다섯 상태는
// 저장하지 않고 세 조각(게이트 상태·봉인 해시==현재 해시·site_posts 유무)의 조합에서 파생한다.
// 「승인자가 본 것 ≠ 승인한 것」(담롱 §4-2 실주행 사고)을 상태 컬럼 하나로 막지 않고, 두 값의
// 비교로 두어 누가 갱신을 잊어도 조용히 틀릴 수 없게 한다(§3-1 [판단]).
//
// ⚠️§8-1 순서 2번 — "상태 파생 로직이 여기서 한 번만 정의된다"는 지시대로 이 파일이 그
// 단일 정의처다. 오늘(S4 1단계, S1 목록 계약만 존재) 시점엔 게이트·봉인 해시·site_posts
// 신호가 전부 화면에 없어(S2·S3가 아직 착지 전) `deriveContentPostStatus`는 항상 'draft'만
// 반환한다 — 필드를 옵셔널로 둬 S2(봉인 해시)·S3(공개 projection) 착지 시 이 함수 본문만
// 채우면 되고, 소비부(목록·상세)는 이 함수를 다시 부르는 것 외에 손댈 필요가 없게 한다.
//
// story #3368 §3-1-1(유나 실측, 2026-09-03) — "모른다"를 다섯 상태에 섞지 않는다. 최초
// 구현은 hashesMatch(둘 다 있고 같다)만 참을 따져, "봉인 해시가 아예 없어 모르는" 경우와
// "해시가 실제로 갈린" 경우가 둘 다 reapproval_needed로 접혔다 — 방향(발행 차단)은
// fail-closed로 안전했지만 문구가 거짓이었다("승인 뒤 본문이 바뀌었습니다"인데 실제로는
// 잴 값이 없을 뿐). 처방 — 상태와 "발행 가능 여부"를 두 축으로 가른다:
//   - 봉인 해시가 없으면(모른다) → 상태는 approved 그대로, publishable=false,
//     blockedReason='SEAL_MISSING'("승인된 버전을 확인할 수 없어 발행할 수 없습니다").
//   - 봉인 해시가 있고 실제로 다르면(안다·갈렸다) → status='reapproval_needed',
//     publishable=false, blockedReason='HASH_MISMATCH'.
// 여섯 번째 상태는 만들지 않는다 — 다섯 상태는 사용자 어휘이고, "승인됐지만 확인 불가"는
// 상태가 아니라 발행 가능 여부의 사정이다(유나 판단 그대로).
export type ContentPostStatus = 'draft' | 'pending' | 'approved' | 'published' | 'reapproval_needed';

export type ContentPostBlockedReason = 'SEAL_MISSING' | 'HASH_MISMATCH';

// story #3368 — external_publish는 Phase 0에서 휴먼 승인만 인정한다(BE 스토리 S3 AC2:
// auto_passed면 403). 유나 설계 §3-1 각주: `auto_passed`는 이 세트에 넣지 않는다 — 서버가
// 그 상태로 이 게이트를 전이시키는 경로 자체가 없어(항상-수동 게이트, story #3291) 도달
// 불가능한 분기이기 때문이다.
type ExternalPublishGateStatus = 'pending' | 'approved' | 'rejected';

export interface ContentPostStatusInput {
  /** 유효한 external_publish 게이트가 없으면 undefined(=초안). */
  gateStatus?: ExternalPublishGateStatus;
  /** 게이트가 봉인한 본문 해시(neutral_facts.content_sha256, S2 착지 후 채워짐). */
  sealedBodySha256?: string;
  /** 지금 이 초안의 최신 버전 본문 해시. */
  currentBodySha256?: string;
  /** 공개 site_posts 행이 있는지(발행 완료 여부, S3 착지 후 채워짐). */
  hasPublishedSitePost?: boolean;
}

export interface ContentPostStatusResult {
  status: ContentPostStatus;
  /** "발행" 버튼을 눌러도 되는가 — status만으로 못 정한다(§3-1-1: approved인데 봉인 값이
   * 없어 확인 불가한 경우도 publishable=false다). */
  publishable: boolean;
  /** publishable===false일 때만 채워진다. 화면은 이 값으로 문구를 가른다(§3-1-1 처방 —
   * "확인 불가"와 "실제로 바뀜"은 다른 문장이어야 한다). */
  blockedReason?: ContentPostBlockedReason;
}

/**
 * §3-1 파생표 + §3-1-1 정정 — 게이트 없음→초안, pending→승인 대기, approved인데 해시
 * 불일치(둘 다 있고 다름)→재승인 필요, approved인데 해시가 아예 없음(둘 중 하나라도
 * 없음)→approved 유지·발행만 차단(SEAL_MISSING), approved+해시 일치(둘 다 있고
 * 같음)→published 또는 approved. rejected는 다섯 상태 밖(디자인 문서가 다루지 않음 —
 * 거절된 게이트는 재상신 전까지 화면상 '초안'과 동형으로 취급: 유효한 승인 대상이 없다는
 * 점에서 게이트 없음과 같다).
 */
export function deriveContentPostStatus(input: ContentPostStatusInput): ContentPostStatusResult {
  if (input.gateStatus === 'pending') return { status: 'pending', publishable: false };
  if (input.gateStatus !== 'approved') return { status: 'draft', publishable: false };

  const bothHashesPresent = input.sealedBodySha256 !== undefined && input.currentBodySha256 !== undefined;

  // §3-1-1 핵심 정정 — 해시 불일치(안다·실제로 갈렸다)를 "모른다"보다 먼저, 그리고
  // 독립적으로 판정한다. hasPublishedSitePost 유무와 무관하게 항상 재승인 필요다 —
  // 이미 발행됐어도 그 뒤 본문이 바뀌었으면 "발행됨"으로 조용히 남으면 안 된다.
  if (bothHashesPresent && input.sealedBodySha256 !== input.currentBodySha256) {
    return { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' };
  }

  if (!bothHashesPresent) {
    // "모른다" — 승인은 실제로 있었으니 상태는 approved 그대로 두고, 발행만 막는다
    // (§3-1-1: 여섯 번째 상태를 만들지 않는다·이유를 지어내지 않는다).
    return { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' };
  }

  // 여기 도달하면 bothHashesPresent && 일치 — §3-1 원래 정의 그대로.
  return input.hasPublishedSitePost
    ? { status: 'published', publishable: true }
    : { status: 'approved', publishable: true };
}

// §6-2 색 매핑 — DOC_STATUS_TONE(components/docs/lib/doc-status-tone.ts)과 같은 규율(배경
// tint+dot 순색+text-foreground, 소형 텍스트에 계열색 직접 금지). 'approved'는 success가
// 아니라 info다 — 아직 밖에 나가지 않은 "진행 중" 상태라 발행됨과 구별해야 한다(§6-2).
export const CONTENT_POST_STATUS_TONE: Record<
  ContentPostStatus,
  { bg: string; dot: string; text: string }
> = {
  draft: { bg: 'bg-muted', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  pending: { bg: 'bg-warning-tint', dot: 'bg-warning', text: 'text-foreground' },
  approved: { bg: 'bg-info-tint', dot: 'bg-info', text: 'text-foreground' },
  published: { bg: 'bg-success-tint', dot: 'bg-success', text: 'text-foreground' },
  reapproval_needed: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
};

export function contentPostStatusLabelKey(status: ContentPostStatus): string {
  switch (status) {
    case 'draft': return 'contentStatusDraft';
    case 'pending': return 'contentStatusPending';
    case 'approved': return 'contentStatusApproved';
    case 'published': return 'contentStatusPublished';
    case 'reapproval_needed': return 'contentStatusReapprovalNeeded';
  }
}
