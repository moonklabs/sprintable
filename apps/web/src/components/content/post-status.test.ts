import { describe, test, expect } from 'vitest';
import {
  deriveContentPostStatus,
  contentPostStatusLabelKey,
  CONTENT_POST_STATUS_TONE,
  type ContentPostStatusInput,
  type ContentPostStatusResult,
} from './post-status';

// story #3368 §3-1-1(유나 실측, 2026-09-03) — 8칸 진리표. 이 테이블 자체가 스펙이다:
// 순수 함수라 실행하면 그대로 재현되고, 여덟 칸 중 두 칸(SEAL_MISSING 둘)이 최초 구현
// 에서 reapproval_needed로 잘못 접혔던 실사고를 이 표가 고정한다.
const CASES: Array<{ name: string; input: ContentPostStatusInput; expected: ContentPostStatusResult }> = [
  { name: '게이트 없음', input: {}, expected: { status: 'draft', publishable: false } },
  { name: '게이트 rejected', input: { gateStatus: 'rejected' }, expected: { status: 'draft', publishable: false } },
  { name: '게이트 pending', input: { gateStatus: 'pending' }, expected: { status: 'pending', publishable: false } },
  {
    name: 'approved + 해시 일치 + 미발행',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: false },
    expected: { status: 'approved', publishable: true },
  },
  {
    name: 'approved + 해시 일치 + 발행됨',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: true },
    expected: { status: 'published', publishable: true },
  },
  {
    name: '⭐approved + 해시 갈림(안다·실제로 바뀜) → 재승인 필요',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'xyz', hasPublishedSitePost: true },
    expected: { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' },
  },
  {
    name: '⭐approved + 봉인 해시 없음(모른다·본문은 안 바뀜) → approved 유지·발행만 차단',
    input: { gateStatus: 'approved' },
    expected: { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' },
  },
  {
    name: '⭐approved + 양쪽 다 없음(모른다) → approved 유지·발행만 차단',
    input: { gateStatus: 'approved', hasPublishedSitePost: true },
    expected: { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' },
  },
];

describe('deriveContentPostStatus (story #3368, doc phase0-post-manager-screen-design §3-1/§3-1-1 — 8칸 진리표)', () => {
  for (const { name, input, expected } of CASES) {
    test(name, () => {
      expect(deriveContentPostStatus(input)).toEqual(expected);
    });
  }

  test('§3-1-1 핵심 — "모른다"(SEAL_MISSING)와 "안다·다르다"(HASH_MISMATCH)는 같은 값으로 접히지 않는다', () => {
    const unknown = deriveContentPostStatus({ gateStatus: 'approved' });
    const known_different = deriveContentPostStatus({ gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'b' });
    expect(unknown.status).not.toBe(known_different.status);
    expect(unknown.blockedReason).toBe('SEAL_MISSING');
    expect(known_different.blockedReason).toBe('HASH_MISMATCH');
  });

  test('여섯 번째 상태를 만들지 않는다 — SEAL_MISSING도 사용자 어휘 다섯 상태 중 하나(approved)로 남는다', () => {
    const result = deriveContentPostStatus({ gateStatus: 'approved' });
    const FIVE_STATUSES = ['draft', 'pending', 'approved', 'published', 'reapproval_needed'];
    expect(FIVE_STATUSES).toContain(result.status);
  });
});

describe('CONTENT_POST_STATUS_TONE / contentPostStatusLabelKey — 다섯 상태 전부 정의', () => {
  test('다섯 상태 모두 tone·labelKey가 존재한다', () => {
    const statuses = ['draft', 'pending', 'approved', 'published', 'reapproval_needed'] as const;
    for (const status of statuses) {
      expect(CONTENT_POST_STATUS_TONE[status]).toBeDefined();
      expect(contentPostStatusLabelKey(status)).toMatch(/^contentStatus/);
    }
  });

  test('approved는 success가 아니라 info 톤이다(§6-2 — 발행됨과 구별)', () => {
    expect(CONTENT_POST_STATUS_TONE.approved.bg).toBe('bg-info-tint');
    expect(CONTENT_POST_STATUS_TONE.published.bg).toBe('bg-success-tint');
  });
});
