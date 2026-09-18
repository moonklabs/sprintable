// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §3-1) — 다섯 상태는
// 저장하지 않고 세 조각(게이트 상태·재승인 신호·site_posts 유무)의 조합에서 파생한다.
// 「승인자가 본 것 ≠ 승인한 것」(담롱 §4-2 실주행 사고)을 상태 컬럼 하나로 막지 않고, 서버가
// 이미 관리하는 신호의 비교로 두어 누가 갱신을 잊어도 조용히 틀릴 수 없게 한다(§3-1 [판단]).
//
// ⚠️§3-1-2(페드루 PO 정정, 2026-09-03 06:42Z — 유나 §3-1-2·PR#3733 실물 대조) — 최초
// 설계는 클라이언트가 "봉인 해시 vs 현재 해시"를 직접 비교해 재승인 필요를 스스로 판정했다.
// 실제 서버(S2)는 승인 뒤 편집이 일어나면 게이트를 approved에 그대로 두지 않고 **pending
// 재오픈 + reapproval_required=true**로 되돌린다(같은 트랜잭션, 봉인 값은 옛 버전 그대로
// 보존). 그래서 "재승인 필요"는 이제 게이트가 직접 들고 있는 신호이지, 클라이언트가 두
// 해시를 비교해 알아내는 값이 아니다:
//   - gateStatus==='pending' && reapprovalRequired===false → 승인 대기(결재자 차례, 처음
//     상신이든 재상신이든 동형)
//   - gateStatus==='pending' && reapprovalRequired===true → 재승인 필요(승인됐던 버전과
//     지금이 다르다 — 서버가 이미 판정해 pending으로 되돌린 것)
//   - gateStatus==='approved' → 봉인분 그대로 발행 가능. 서버의 gates.py 승인 전이 가드가
//     reapproval_required=true인 게이트의 approve 자체를 409 SITE_POST_RESUBMIT_REQUIRED로
//     막아 두므로, 여기 도달하는 approved 게이트는 이미 최신 버전과 일치가 보장된다.
// 해시 비교(sealedBodySha256 vs currentBodySha256)는 이제 approved 분기의 **방어망**으로만
// 남는다 — S2 이전에 만들어졌거나 이 가드를 우회해 approved된 구식/우회 게이트 대비
// (SEAL_MISSING/HASH_MISMATCH). 정상 경로에서는 이 방어망에 걸릴 일이 없다.
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
  /** gate.reapproval_required — 서버가 판정한 재승인 필요 여부(§3-1-2, gateStatus==='pending'
   * 일 때만 의미 있다). undefined면 false와 동형으로 취급(구 계약·필드 부재 시 안전 기본값). */
  reapprovalRequired?: boolean;
  /** 방어망 전용(§3-1-2) — 게이트가 봉인한 본문 해시(gate.sealed_content_sha256). */
  sealedBodySha256?: string;
  /** 방어망 전용 — 지금 이 초안의 최신 버전 본문 해시. */
  currentBodySha256?: string;
  /** 공개 site_posts 행이 있는지(발행 완료 여부, S3 착지 후 채워짐). undefined=아직
   * 모른다(서버 계약 미배선·요청 진행 중) — false(미발행)와 다른 신호다. story #3386
   * AC6: undefined일 때 이 함수는 status 자체를 비운다(«승인됨»으로 단정하지 않는다). */
  hasPublishedSitePost?: boolean;
  /** story #3386(신규, 목록·상세 계약표엔 없던 필드 — 디디 판단) — 지금 라이브인
   * site_posts 행 본문의 해시. sealedBodySha256(지금 승인된 본문)과 달라지는 순간이
   * "재승인은 됐는데 아직 재발행 버튼을 안 눌렀다" — «발행»을 다시 열어야 하는 유일한
   * 신호다. hasPublishedSitePost=true일 때만 의미 있다. */
  publishedBodySha256?: string;
}

export interface ContentPostStatusResult {
  /** undefined = 판별 불가(입력 부족, 주로 hasPublishedSitePost===undefined) — 화면은
   * 색 있는 칩 대신 「—」를 그린다(§3-1-1 "모른다≠다르다", AuthorKindBadge와 동일 규율
   * — story #3386 AC6·0b72a300 AC4, 두 표면이 같은 말을 한다). */
  status: ContentPostStatus | undefined;
  /** "발행" 버튼을 눌러도 되는가 — status만으로 못 정한다(방어망 분기: approved인데 봉인
   * 값이 없어 확인 불가한 경우도 publishable=false다). */
  publishable: boolean;
  /** true면 이미 발행된 글에 "재승인된 새 버전"이 있어 버튼을 다시 열어야 하는 경우
   * (story #3386 AC2) — 라벨을 「발행」이 아니라 「재발행」으로 바꾸는 신호. status===
   * 'published'일 때만 의미 있다(그 밖엔 항상 undefined). */
  isRepublish?: boolean;
  /** publishable===false일 때만 채워진다. 화면은 이 값으로 문구를 가른다 — "확인 불가"와
   * "실제로 바뀜"은 다른 문장이어야 한다(§3-1-1 처방, 방어망 분기에서만 쓰인다). */
  blockedReason?: ContentPostBlockedReason;
}

/**
 * §3-1-2 파생표(정본) — 게이트 없음→초안, pending+reapproval_required=false→승인 대기,
 * pending+reapproval_required=true→재승인 필요(서버 판정 그대로), approved→봉인분
 * 발행 가능(또는 published, site_posts 있으면). approved인데 해시가 없거나 다른 경우는
 * 정상 경로로 도달 불가능한 방어망(§3-1-2 "이중으로 도달 불가" — gates.py의 approve 전이
 * 가드가 이미 막는다)만 남는다. rejected는 다섯 상태 밖(디자인 문서가 다루지 않음 — 거절된
 * 게이트는 재상신 전까지 화면상 '초안'과 동형으로 취급: 유효한 승인 대상이 없다는 점에서
 * 게이트 없음과 같다).
 *
 * story #3386(2026-09-03, 원인 진단·PO 확定) — approved 분기 끝에서 hasPublishedSitePost가
 * undefined면(계약 미배선·요청 중) 「승인됨」으로 단정하지 않고 status를 비운다(AC6). true면
 * published — 이때 publishedBodySha256이 sealedBodySha256과 다르면(재승인된 새 버전이
 * 아직 안 나갔다) publishable·isRepublish를 true로 열어 「재발행」을 허용한다(AC2) — 둘이
 * 같으면(막 발행했거나 이미 최신을 반영했다) publishable=false로 기본 잠금.
 */
export function deriveContentPostStatus(input: ContentPostStatusInput): ContentPostStatusResult {
  if (input.gateStatus === 'pending') {
    return input.reapprovalRequired
      ? { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' }
      : { status: 'pending', publishable: false };
  }
  if (input.gateStatus !== 'approved') return { status: 'draft', publishable: false };

  // approved 방어망(§3-1-2) — 정상 경로로는 도달 불가(gates.py 가드가 이중으로 막는다).
  const bothHashesPresent = input.sealedBodySha256 !== undefined && input.currentBodySha256 !== undefined;
  if (bothHashesPresent && input.sealedBodySha256 !== input.currentBodySha256) {
    return { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' };
  }
  if (!bothHashesPresent) {
    return { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' };
  }

  if (input.hasPublishedSitePost === undefined) {
    // AC6(0a9c73c3)·목록 AC4(0b72a300) — 발행 여부를 모르는 동안 「승인됨」이라 단정하지
    // 않는다. status 자체를 비워 StatusChip이 「—」를 그리게 한다.
    return { status: undefined, publishable: false };
  }
  if (!input.hasPublishedSitePost) {
    return { status: 'approved', publishable: true };
  }

  const hasUnpublishedApproval = input.publishedBodySha256 !== undefined
    && input.publishedBodySha256 !== input.sealedBodySha256;
  return { status: 'published', publishable: hasUnpublishedApproval, isRepublish: hasUnpublishedApproval };
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
