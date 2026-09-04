// story #3402(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03 23:19Z) — 채널 포스트는 다섯 상태
// (draft/pending/approved/published/reapproval_needed) 파생을 그대로 쓰되, Threads 발행이
// 2-호출(컨테이너 생성→publish)이라 「부분 성공」(컨테이너는 생겼는데 게시가 안 됨)이라는
// 여섯 번째 신호가 더 있다(설계 문서 §4-1 — "이것은 다섯 상태 어디에도 없다"). PO 결정: 5상태
// 파생(post-status.ts::deriveContentPostStatus)은 건드리지 않고, 이 파일이 그 결과 위에
// publication_status(container_created→부분 성공·failed→발행 실패)를 오버레이한다 — 5상태가
// 두 벌이 되면(사이트/채널 각자 손보다 갈라짐) 다음 사람이 어느 쪽이 정본인지 잃는다.
import {
  deriveContentPostStatus,
  type ContentPostStatusInput,
  type ContentPostStatusResult,
} from './post-status';

// story #3426(페드루 PO 정정 2026-09-04 08:40Z) — 4번째 값 'unpublished'(회수됨,
// doc §17-10②). 회수 성공 응답 뒤 서버가 다음 로드에서 실제로 주는 값과 같은 모양 —
// published_at=null·publication_status='unpublished'가 함께 온다(§4-2 두 조인축의
// "가장 최근 published" 쪽이 이제 없다는 뜻).
export type ChannelPublicationStatus = 'container_created' | 'published' | 'failed' | 'unpublished';

export interface ChannelPostViewInput extends Omit<ContentPostStatusInput, 'hasPublishedSitePost'> {
  /** channel_publications.status — 최신 버전 publication 행(#3394 AC2 ⓑ). 발행 이력 없으면
   * null, 계약 자체가 아직 안 실렸으면(구 계약) undefined. */
  publicationStatus?: ChannelPublicationStatus | null;
  /** publicationStatus==='failed'일 때만 의미 있다 — 부분 성공/실패 카드의 문구 분기(story
   * #3402 AC10 오류 표). */
  errorCode?: string | null;
  /** #3394 AC2 ⓐ — 이 draft(gate)의 "가장 최근 published 상태 publication"의 published_at.
   * hasPublishedSitePost 파생 입력(post-status.ts와 동형 — 키 부재와 null을 갈라야 한다,
   * 호출부가 'published_at' in item으로 판단해 넘긴다). */
  publishedAt?: string | null;
}

export interface ChannelPostViewResult extends ContentPostStatusResult {
  /** true면 최신 버전이 container_created(컨테이너는 생겼는데 게시 안 됨) — 기본 행동은
   * "이어서 발행"이지 "새로 시도"가 아니다(설계 §4-1, story #3402 AC3). status(5상태 파생)와
   * 독립적으로 true일 수 있다 — 부분 성공은 다섯 상태 어디에도 없기 때문이다. */
  partialSuccess: boolean;
  /** true면 최신 버전이 failed — 그 행이 제자리에 남고 재시도가 그 행을 쓴다(§4-2 표). */
  publicationFailed: boolean;
  /** publicationFailed일 때만 채워진다. */
  errorCode?: string | null;
  /** story #3426 — true면 회수됨(doc §17-10②). status(5상태)는 이 값과 무관하게 게이트
   * 축 그대로 파생된다(회수해도 approved 승인 자체는 안 풀린다) — 칩 「승인됨」 위에
   * 이 오버레이가 「회수됨」을 얹는다(partialSuccess/publicationFailed와 같은 자리). */
  unpublished: boolean;
}

/**
 * 5상태 파생(deriveContentPostStatus) 위에 채널 고유 publication_status를 얹는다. 두 신호는
 * 서로 다른 축이다 — approved/published 같은 게이트·발행 상태는 site와 동일 의미로 그대로
 * 파생하고, container_created/failed는 "그 위에 추가로 알아야 하는 것"으로 별도 필드에 얹는다
 * (5상태 유니온에 새 값을 추가하지 않는다 — 그러면 site 컴포넌트가 못 보는 값이 섞여 들어가
 * StatusChip 등 공유 컴포넌트가 깨진다).
 */
export function deriveChannelPostView(input: ChannelPostViewInput): ChannelPostViewResult {
  const { publicationStatus, errorCode, publishedAt, ...rest } = input;

  // story #3402 AC2·PO 결정 — publication_status와 published_at 둘 다 계약에 없으면(구 계약)
  // "모른다"(undefined)로 남긴다. 둘 중 하나라도 있으면 "published_at != null 이거나
  // publication_status가 published"를 hasPublishedSitePost로 삼는다(둘은 서로 다른 조인 축
  // — published_at은 "가장 최근 published 발행", publication_status는 "최신 버전"이라 OR로
  // 합쳐야 "과거에 발행됐지만 최신 버전은 아직 재발행 전"인 경우도 놓치지 않는다).
  const hasPublishedSitePost =
    publicationStatus === undefined && publishedAt === undefined
      ? undefined
      : publicationStatus === 'published' || publishedAt != null;

  const base = deriveContentPostStatus({ ...rest, hasPublishedSitePost });

  return {
    ...base,
    partialSuccess: publicationStatus === 'container_created',
    publicationFailed: publicationStatus === 'failed',
    errorCode: publicationStatus === 'failed' ? errorCode : undefined,
    unpublished: publicationStatus === 'unpublished',
  };
}
