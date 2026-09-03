import { describe, test, expect } from 'vitest';
import { deriveContentPostStatus, contentPostStatusLabelKey, CONTENT_POST_STATUS_TONE } from './post-status';

describe('deriveContentPostStatus (story #3368, doc phase0-post-manager-screen-design §3-1)', () => {
  test('게이트 없음(undefined) → draft', () => {
    expect(deriveContentPostStatus({})).toBe('draft');
  });

  test('게이트 status=pending → pending', () => {
    expect(deriveContentPostStatus({ gateStatus: 'pending' })).toBe('pending');
  });

  test('게이트 status=rejected → draft(유효한 승인 대상 없음, 게이트 없음과 동형)', () => {
    expect(deriveContentPostStatus({ gateStatus: 'rejected' })).toBe('draft');
  });

  test('approved + 해시 일치 + site_posts 없음 → approved(발행 대기)', () => {
    expect(
      deriveContentPostStatus({
        gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: false,
      }),
    ).toBe('approved');
  });

  test('approved + 해시 일치 + site_posts 있음 → published', () => {
    expect(
      deriveContentPostStatus({
        gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: true,
      }),
    ).toBe('published');
  });

  test('⭐approved인데 해시 불일치(승인 후 본문 수정) → reapproval_needed — 이 파일이 붙잡은 핵심 사고 방지', () => {
    expect(
      deriveContentPostStatus({
        gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'xyz', hasPublishedSitePost: true,
      }),
    ).toBe('reapproval_needed');
  });

  test('approved인데 해시 정보 자체가 없으면(S2 미착지) 안전측 reapproval_needed로 fail-closed — published로 조용히 넘어가지 않는다', () => {
    expect(deriveContentPostStatus({ gateStatus: 'approved' })).toBe('reapproval_needed');
  });

  test('오늘(S1 목록 계약만 존재) — 게이트 신호가 아예 없는 입력({})은 항상 draft', () => {
    for (const _ of [1, 2, 3]) {
      expect(deriveContentPostStatus({})).toBe('draft');
    }
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
