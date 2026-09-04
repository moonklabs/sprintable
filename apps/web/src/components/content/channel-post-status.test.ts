import { describe, test, expect } from 'vitest';
import { deriveChannelPostView, type ChannelPostViewInput, type ChannelPostViewResult } from './channel-post-status';

// story #3402 AC1/AC2/AC3 — 5상태 파생(post-status.ts)은 손대지 않고 그 위에
// publication_status를 오버레이한다. 이 표가 두 축(5상태 × publication_status 3값)의 진리표
// 정본이다(AC15 QA 요구 — 진리표 테스트).
const CASES: Array<{ name: string; input: ChannelPostViewInput; expected: Partial<ChannelPostViewResult> }> = [
  {
    name: '게이트 없음(초안) — publication_status 없음',
    input: {},
    expected: { status: 'draft', publishable: false, partialSuccess: false, publicationFailed: false },
  },
  {
    name: 'pending — publication_status 무관(아직 발행 안 됨)',
    input: { gateStatus: 'pending', reapprovalRequired: false, publicationStatus: null },
    expected: { status: 'pending', publishable: false, partialSuccess: false, publicationFailed: false },
  },
  {
    name: 'AC3 핵심 — container_created(부분 성공)는 5상태 파생과 독립된 신호',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'container_created', publishedAt: null,
    },
    expected: { status: 'approved', publishable: true, partialSuccess: true, publicationFailed: false },
  },
  {
    name: 'failed — errorCode가 함께 실린다',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'failed', errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR', publishedAt: null,
    },
    expected: { partialSuccess: false, publicationFailed: true, errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR' },
  },
  {
    name: 'published — publication_status=published가 hasPublishedSitePost를 채운다',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'published', publishedAt: '2026-09-03T00:00:00Z',
    },
    expected: { status: 'published', publishable: false, partialSuccess: false, publicationFailed: false },
  },
  {
    name: '과거에 발행됐지만(published_at 있음) 최신 버전은 아직 재발행 전(publication_status=null)',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'b', currentBodySha256: 'b',
      publicationStatus: null, publishedAt: '2026-09-01T00:00:00Z',
    },
    expected: { status: 'published', partialSuccess: false, publicationFailed: false },
  },
  {
    name: 'AC2 — publication_status·published_at 둘 다 계약에 없음(구 계약) → hasPublishedSitePost 모름 → status undefined',
    input: { gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a' },
    expected: { status: undefined, publishable: false, partialSuccess: false, publicationFailed: false },
  },
  {
    name: 'errorCode는 publicationFailed일 때만 실린다(container_created에 errorCode가 와도 무시)',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'container_created', errorCode: 'SHOULD_NOT_LEAK', publishedAt: null,
    },
    expected: { partialSuccess: true, errorCode: undefined },
  },
];

describe('deriveChannelPostView', () => {
  test.each(CASES)('$name', ({ input, expected }) => {
    const result = deriveChannelPostView(input);
    expect(result).toMatchObject(expected);
  });
});
