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
export type ContentPostStatus = 'draft' | 'pending' | 'approved' | 'published' | 'reapproval_needed';

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

/**
 * §3-1 파생표 그대로: 게이트 없음→초안, pending→승인 대기, approved(해시 일치·미발행)→승인됨,
 * approved(해시 일치·발행)→발행됨, approved(해시 불일치)→재승인 필요. rejected는 다섯 상태
 * 밖(디자인 문서가 다루지 않음 — 거절된 게이트는 재상신 전까지 화면상 '초안'과 동형으로 취급:
 * 유효한 승인 대상이 없다는 점에서 게이트 없음과 같다).
 */
export function deriveContentPostStatus(input: ContentPostStatusInput): ContentPostStatus {
  if (input.gateStatus === 'pending') return 'pending';
  if (input.gateStatus !== 'approved') return 'draft';

  const hashesMatch =
    input.sealedBodySha256 !== undefined &&
    input.currentBodySha256 !== undefined &&
    input.sealedBodySha256 === input.currentBodySha256;
  if (!hashesMatch) return 'reapproval_needed';

  return input.hasPublishedSitePost ? 'published' : 'approved';
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
