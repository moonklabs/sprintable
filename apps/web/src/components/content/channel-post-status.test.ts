import { describe, test, expect } from 'vitest';
import { deriveChannelPostView, type ChannelPostViewInput, type ChannelPostViewResult } from './channel-post-status';

// story #3402 AC15(카디르 QA·페드루 PO 정정 2026-09-04) — 이 표가 5상태×publication_status
// 3값(=15칸)의 진리표 정본이다. 이전 판(WIP1)은 주석만 "정본"이라 적고 실제론 8/15칸이었다
// (카디르 QA 계획 실측 지적) — 이번 판이 그 15칸을 실제로 채운다.
//
// 5행 정의(카디르 표 그대로, PO 정정 반영):
//   1. 없음(gate 자체 X) · 2. pending · 3. approved(published_at 없음) ·
//   4. rejected(PO 확定: 새 칩 만들지 않음 — deriveContentPostStatus 자체 결과가 정본,
//      gateStatus!=='approved'면 무조건 draft로 접히므로 1행과 동형) · 5. reapproval_required=true
// 3열: A=null(미발행) · B=container_created(부분 성공) · C=failed(실패)
// + 「키 부재」행(gate_status·publication_status 둘 다 응답에 없음, null이 아니라 진짜 부재)
// + 캐치올(published_at 있으면 A/B/C와 "중첩"으로 보인다 — PO 정정: 우선순위로 가리는 게
//   아니라 status='published'와 publicationFailed=true가 동시에 참일 수 있다)
const CASES: Array<{ name: string; input: ChannelPostViewInput; expected: Partial<ChannelPostViewResult> }> = [
  // ── 1행: 게이트 없음 ──────────────────────────────────────────────
  { name: '1-A 없음×null', input: {}, expected: { status: 'draft', publishable: false, partialSuccess: false, publicationFailed: false } },
  {
    name: '1-B 없음×container_created(방어적 조합 — gate 없어도 partialSuccess 플래그 자체는 열의 값 그대로)',
    input: { publicationStatus: 'container_created', publishedAt: null },
    expected: { status: 'draft', partialSuccess: true, publicationFailed: false },
  },
  {
    name: '1-C 없음×failed',
    input: { publicationStatus: 'failed', errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR', publishedAt: null },
    expected: { status: 'draft', partialSuccess: false, publicationFailed: true, errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR' },
  },
  // ── 2행: pending ──────────────────────────────────────────────────
  {
    name: '2-A pending×null',
    input: { gateStatus: 'pending', reapprovalRequired: false, publicationStatus: null },
    expected: { status: 'pending', publishable: false, partialSuccess: false, publicationFailed: false },
  },
  {
    name: '2-B pending×container_created',
    input: { gateStatus: 'pending', reapprovalRequired: false, publicationStatus: 'container_created', publishedAt: null },
    expected: { status: 'pending', partialSuccess: true, publicationFailed: false },
  },
  {
    name: '2-C pending×failed',
    input: { gateStatus: 'pending', reapprovalRequired: false, publicationStatus: 'failed', publishedAt: null },
    expected: { status: 'pending', partialSuccess: false, publicationFailed: true },
  },
  // ── 3행: approved(published_at 없음) — AC3 핵심, 세 열이 실제로 갈린다 ─────
  {
    name: '3-A approved×null — 단순 승인됨, 기본행동 발행',
    input: { gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a', publicationStatus: null, publishedAt: null },
    expected: { status: 'approved', publishable: true, partialSuccess: false, publicationFailed: false },
  },
  {
    name: '3-B approved×container_created — AC3 핵심, 기본행동 "이어서 발행"',
    input: { gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a', publicationStatus: 'container_created', publishedAt: null },
    expected: { status: 'approved', publishable: true, partialSuccess: true, publicationFailed: false },
  },
  {
    name: '3-C approved×failed — errorCode 실림, 기본행동 "다시 시도"(그 행 재사용)',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'failed', errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR', publishedAt: null,
    },
    expected: { status: 'approved', partialSuccess: false, publicationFailed: true, errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR' },
  },
  // ── 4행: rejected — PO 확定, deriveContentPostStatus 자체 결과가 정본(새 칩 없음,
  //         gateStatus!=='approved'면 무조건 draft) — 1행과 동형이어야 한다 ──────────
  { name: '4-A rejected×null(1행과 동형이어야 함)', input: { gateStatus: 'rejected', publicationStatus: null }, expected: { status: 'draft', publishable: false } },
  { name: '4-B rejected×container_created', input: { gateStatus: 'rejected', publicationStatus: 'container_created', publishedAt: null }, expected: { status: 'draft', partialSuccess: true } },
  { name: '4-C rejected×failed', input: { gateStatus: 'rejected', publicationStatus: 'failed', publishedAt: null }, expected: { status: 'draft', publicationFailed: true } },
  // ── 5행: reapproval_required=true — publication_status 무관하게 이 칩이 이긴다 ────
  {
    name: '5-A 재승인필요×null',
    input: { gateStatus: 'pending', reapprovalRequired: true, publicationStatus: null },
    expected: { status: 'reapproval_needed', partialSuccess: false, publicationFailed: false },
  },
  {
    name: '5-B 재승인필요×container_created(옛 발행시도 흔적은 새 버전엔 무의미해도 플래그 자체는 열 그대로)',
    input: { gateStatus: 'pending', reapprovalRequired: true, publicationStatus: 'container_created', publishedAt: null },
    expected: { status: 'reapproval_needed', partialSuccess: true },
  },
  {
    name: '5-C 재승인필요×failed',
    input: { gateStatus: 'pending', reapprovalRequired: true, publicationStatus: 'failed', publishedAt: null },
    expected: { status: 'reapproval_needed', publicationFailed: true },
  },
  // ── 키 부재 열(AC2 fail-safe) — gate_status·publication_status 둘 다 계약에 없음
  //    (undefined, null 아님). 5행 전부 「—」(status undefined)로 접혀야 한다 ───────────
  // gateStatus 자체가 없으면 deriveContentPostStatus가 무조건 'draft'로 접는다(§Phase0
  // 원설계 — gate 부재는 "모른다"가 아니라 "아직 상신 안 함"이 확정적으로 참이다). AC2의
  // "모른다≠아니다" fail-safe는 gateStatus==='approved'인데 발행신호가 없는 경우에만
  // 발동한다(아래 별도 케이스) — gate 자체의 부재는 이미 확정적 사실이라 실제로 undefined
  // 로 접힐 여지가 없다(§Phase0 함수 자체 검증).
  { name: '키부재 — gate/publication 신호 전부 없음(gateStatus 부재=확정적 draft, undefined 아님)', input: {}, expected: { status: 'draft', partialSuccess: false, publicationFailed: false } },
  {
    name: '키부재 — pending인데 발행신호는 부재',
    input: { gateStatus: 'pending', reapprovalRequired: false },
    expected: { status: 'pending', partialSuccess: false, publicationFailed: false },
  },
  {
    name: 'AC2 핵심 — approved인데 발행신호(publicationStatus·publishedAt) 둘 다 부재 → hasPublishedSitePost 모름 → status undefined(승인됨으로 잘못 단정 금지)',
    input: { gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a' },
    expected: { status: undefined, publishable: false, partialSuccess: false, publicationFailed: false },
  },
  // ── 캐치올 — published_at 있으면 A/B/C를 "가리는" 게 아니라 "중첩"된다(PO 정정) ────
  {
    name: '캐치올 — approved+published_at있음+publication_status=failed(이전 버전 발행 뒤 새 버전 재발행 실패) → 칩은 published, publicationFailed도 동시에 true(중첩, 우선순위 아님)',
    input: {
      gateStatus: 'approved', sealedBodySha256: 'a', currentBodySha256: 'a',
      publicationStatus: 'failed', errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR', publishedAt: '2026-09-01T00:00:00Z',
    },
    expected: { status: 'published', publicationFailed: true, errorCode: 'CHANNEL_PUBLISH_PROVIDER_ERROR' },
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

describe('deriveChannelPostView — AC15 진리표(15칸+키부재5+캐치올)', () => {
  test.each(CASES)('$name', ({ input, expected }) => {
    const result = deriveChannelPostView(input);
    expect(result).toMatchObject(expected);
  });

  // 카디르 QA 계획 ⑥ — "돌기는 하는데 결과가 사실 3~4갈래로만 겹친다"면 표가 무의미해진다.
  // 3행(approved)의 A/B/C가 실제로 서로 다른 partialSuccess/publicationFailed 조합을 내는지
  // 인접 비교로 pin한다(진짜 진리표라면 이 세 칸은 서로 달라야 한다).
  test('3행(approved)의 A/B/C는 서로 다른 결과를 낸다(인접 칸 구별 확인)', () => {
    const base = { gateStatus: 'approved' as const, sealedBodySha256: 'a', currentBodySha256: 'a' };
    const a = deriveChannelPostView({ ...base, publicationStatus: null, publishedAt: null });
    const b = deriveChannelPostView({ ...base, publicationStatus: 'container_created', publishedAt: null });
    const c = deriveChannelPostView({ ...base, publicationStatus: 'failed', publishedAt: null });
    expect([a.partialSuccess, a.publicationFailed]).toEqual([false, false]);
    expect([b.partialSuccess, b.publicationFailed]).toEqual([true, false]);
    expect([c.partialSuccess, c.publicationFailed]).toEqual([false, true]);
  });
});
