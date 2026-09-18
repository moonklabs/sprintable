import { describe, test, expect } from 'vitest';
import {
  deriveContentPostStatus,
  contentPostStatusLabelKey,
  CONTENT_POST_STATUS_TONE,
  type ContentPostStatusInput,
  type ContentPostStatusResult,
} from './post-status';

// story #3368 §3-1-2(페드루 PO 정정, 2026-09-03 06:42Z — 유나 §3-1-2·PR#3733 실물 대조) —
// 재승인 필요는 서버가 이미 pending+reapproval_required로 판정해 두는 신호이지, 클라이언트가
// 두 해시를 비교해 알아내는 값이 아니다. 이 표가 그 정본이다.
const CASES: Array<{ name: string; input: ContentPostStatusInput; expected: ContentPostStatusResult }> = [
  { name: '게이트 없음', input: {}, expected: { status: 'draft', publishable: false } },
  { name: '게이트 rejected', input: { gateStatus: 'rejected' }, expected: { status: 'draft', publishable: false } },
  {
    name: '⭐pending + reapproval_required=false → 승인 대기(처음 상신이든 재상신이든 동형)',
    input: { gateStatus: 'pending', reapprovalRequired: false },
    expected: { status: 'pending', publishable: false },
  },
  {
    name: '⭐pending + reapproval_required=true → 재승인 필요(서버 판정 그대로, 해시 비교 불필요)',
    input: { gateStatus: 'pending', reapprovalRequired: true },
    expected: { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' },
  },
  {
    name: 'pending + reapprovalRequired 필드 부재(구 계약) → 안전 기본값 false와 동형',
    input: { gateStatus: 'pending' },
    expected: { status: 'pending', publishable: false },
  },
  {
    name: 'approved + 해시 일치 + 미발행',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: false },
    expected: { status: 'approved', publishable: true },
  },
  {
    // story #3386(2026-09-03) 정정 — 이전엔 이 케이스가 publishable:true였다(발행된 글도
    // «발행» 버튼이 계속 열려 있던 실사고 그 자체, 원인 진단이 확認한 버그). 라이브 본문
    // 해시(publishedBodySha256)를 아직 모르면(구 계약처럼 안 넘기면) 안전 기본값은 이제
    // false다 — «재발행할 게 있는지 모르면 열지 않는다»(AC2·§3-1-1 "모른다≠다르다"와 같은
    // 원칙을 approved 방어망뿐 아니라 published 분기에도 적용).
    name: 'approved + 해시 일치 + 발행됨(라이브 해시 모름) → 발행됨이지만 기본 잠금',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc', hasPublishedSitePost: true },
    expected: { status: 'published', publishable: false, isRepublish: false },
  },
  {
    name: '⭐발행됨 + 라이브 해시=승인 해시(막 발행했거나 최신 그대로) → 재발행 불필요, 버튼 잠금',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc',
      hasPublishedSitePost: true, publishedBodySha256: 'abc',
    },
    expected: { status: 'published', publishable: false, isRepublish: false },
  },
  {
    name: '⭐발행됨 + 라이브 해시≠승인 해시(재승인된 새 버전이 아직 안 나갔다) → 재발행 가능',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'new-hash', currentBodySha256: 'new-hash',
      hasPublishedSitePost: true, publishedBodySha256: 'old-hash',
    },
    expected: { status: 'published', publishable: true, isRepublish: true },
  },
  {
    name: '⭐AC6 — approved + hasPublishedSitePost=undefined(모름) → status를 비운다(«승인됨» 단정 금지)',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'abc' },
    expected: { status: undefined, publishable: false },
  },
  {
    name: '방어망 — approved인데 해시 갈림(정상 경로로 도달 불가, gates.py 가드가 이중 차단)',
    input: { gateStatus: 'approved', sealedBodySha256: 'abc', currentBodySha256: 'xyz', hasPublishedSitePost: true },
    expected: { status: 'reapproval_needed', publishable: false, blockedReason: 'HASH_MISMATCH' },
  },
  {
    name: '방어망 — approved인데 봉인 해시 없음(구식/우회 게이트) → 승인됨 유지·발행만 차단',
    input: { gateStatus: 'approved' },
    expected: { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' },
  },
  {
    name: '방어망 — approved + 양쪽 다 없음',
    input: { gateStatus: 'approved', hasPublishedSitePost: true },
    expected: { status: 'approved', publishable: false, blockedReason: 'SEAL_MISSING' },
  },
];

describe('deriveContentPostStatus (story #3368, doc phase0-post-manager-screen-design §3-1-2 — 정본 진리표)', () => {
  for (const { name, input, expected } of CASES) {
    test(name, () => {
      expect(deriveContentPostStatus(input)).toEqual(expected);
    });
  }

  test('§3-1-2 핵심 — pending 분기는 reapprovalRequired만 보고, 해시 필드 유무와 무관하다', () => {
    const withHashes = deriveContentPostStatus({
      gateStatus: 'pending', reapprovalRequired: true, sealedBodySha256: 'a', currentBodySha256: 'a',
    });
    const withoutHashes = deriveContentPostStatus({ gateStatus: 'pending', reapprovalRequired: true });
    expect(withHashes).toEqual(withoutHashes);
  });

  test('여섯 번째 상태를 만들지 않는다 — 방어망 SEAL_MISSING도 사용자 어휘 다섯 상태 중 하나(approved)로 남는다', () => {
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
