// story #2905(S2c③④) — 세그먼트 판별 순수 로직 단위 테스트. delta 시안(`s2c-delta-grouping-
// states`) §① 규칙 전수 — 그룹 조건(같은 타입+sole-link+2개↑+사이 산문 없음)·공백줄 예외·
// 산문 단절·타입별 서브그룹. entity ref 파싱(entity-ref.ts)이 id를 UUID로만 받아들이므로
// (비-UUID는 매칭 실패→평문 폴백) 픽스처 id는 전부 유효한 UUID로 둔다.
import { describe, expect, it } from 'vitest';
import { segmentMessageContent } from './message-segments';

const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '22222222-2222-2222-2222-222222222222';
const S3 = '33333333-3333-3333-3333-333333333333';
const D1 = '44444444-4444-4444-4444-444444444444';
const D2 = '55555555-5555-5555-5555-555555555555';
const G1 = '66666666-6666-6666-6666-666666666666';
const G2 = '77777777-7777-7777-7777-777777777777';
const A1 = '88888888-8888-8888-8888-888888888888';
const A2 = '99999999-9999-9999-9999-999999999999';
const GHOST1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GHOST2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AS1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const AS2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const REFS_ALL_OBSERVED = [
  { target_type: 'story', target_id: S1 },
  { target_type: 'story', target_id: S2 },
  { target_type: 'story', target_id: S3 },
  { target_type: 'doc', target_id: D1 },
  { target_type: 'doc', target_id: D2 },
  { target_type: 'gate', target_id: G1 },
  { target_type: 'gate', target_id: G2 },
  { target_type: 'artifact', target_id: A1 },
  { target_type: 'artifact', target_id: A2 },
];

function link(type: string, id: string, label = id) {
  return `[${label}](entity:${type}:${id})`;
}

describe('segmentMessageContent — 그룹 조건', () => {
  it('같은 타입 sole-link 2개(공백줄 하나로만 분리) — 그룹 세그먼트 1개', () => {
    const content = `${link('story', S1)}\n\n${link('story', S2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: S1 }, { entityId: S2, label: S2 }] }]);
  });

  it('같은 타입 sole-link 1개뿐 — 그룹 아님(텍스트 세그먼트로 남는다)', () => {
    const content = link('story', S1);
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'text', text: content }]);
  });

  it('여분의 공백줄(3줄 이상)도 여전히 연속 — run이 안 끊긴다', () => {
    const content = `${link('story', S1)}\n\n\n\n${link('story', S2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: S1 }, { entityId: S2, label: S2 }] }]);
  });

  it('사이에 산문 문단이 끼면 run이 끊긴다 — 각자 단건(비그룹) 텍스트 세그먼트', () => {
    const content = `${link('story', S1)}\n\n이건 산문이다\n\n${link('story', S2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'text', text: content }]);
  });

  it('다른 타입 섞인 연속 sole-link — 타입별 서브그룹 2개로 갈린다', () => {
    const content = `${link('story', S1)}\n\n${link('story', S2)}\n\n${link('doc', D1)}\n\n${link('doc', D2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([
      { kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: S1 }, { entityId: S2, label: S2 }] },
      { kind: 'group', entityType: 'doc', refs: [{ entityId: D1, label: D1 }, { entityId: D2, label: D2 }] },
    ]);
  });

  it('산문 속 인라인 참조(문단에 다른 텍스트 있음) — sole-link 아니라 그룹 대상 아님', () => {
    const content = `앞에 ${link('story', S1)} 뒤에도 텍스트\n\n${link('story', S2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'text', text: content }]);
  });

  it('gate 2개 연속 — gate 그룹 세그먼트', () => {
    const content = `${link('gate', G1)}\n\n${link('gate', G2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'group', entityType: 'gate', refs: [{ entityId: G1, label: G1 }, { entityId: G2, label: G2 }] }]);
  });

  it('artifact 2개 연속 — artifact 그룹 세그먼트', () => {
    const content = `${link('artifact', A1)}\n\n${link('artifact', A2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'group', entityType: 'artifact', refs: [{ entityId: A1, label: A1 }, { entityId: A2, label: A2 }] }]);
  });

  it('유령 참조(stored references에 없음) sole-link 2개 — 카드 판정 자체가 아니므로 그룹 대상 아님', () => {
    const content = `${link('story', GHOST1)}\n\n${link('story', GHOST2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'text', text: content }]);
  });

  it('references === undefined(판단 재료 없음) — 유령 판정 보류라 sole-link 카드로 정상 그룹', () => {
    const content = `${link('story', S1)}\n\n${link('story', S2)}`;
    const segs = segmentMessageContent(content, undefined);
    expect(segs).toEqual([{ kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: S1 }, { entityId: S2, label: S2 }] }]);
  });

  it('asset 타입 sole-link 2개 — asset은 카드가 아니라(§EmbedRenderer) 그룹 대상 아님', () => {
    const content = `${link('asset', AS1)}\n\n${link('asset', AS2)}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'text', text: content }]);
  });

  it('3개 연속 + 앞뒤 산문 — 산문은 별도 텍스트 세그먼트, 중간만 그룹', () => {
    const content = `머리말\n\n${link('story', S1)}\n\n${link('story', S2)}\n\n${link('story', S3)}\n\n꼬리말`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([
      { kind: 'text', text: '머리말' },
      { kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: S1 }, { entityId: S2, label: S2 }, { entityId: S3, label: S3 }] },
      { kind: 'text', text: '꼬리말' },
    ]);
  });

  it('라벨이 링크 텍스트와 다른 경우(제목 붙은 참조) — refs.label에 그 라벨이 실린다', () => {
    const content = `${link('story', S1, '스토리 하나')}\n\n${link('story', S2, '스토리 둘')}`;
    const segs = segmentMessageContent(content, REFS_ALL_OBSERVED);
    expect(segs).toEqual([{ kind: 'group', entityType: 'story', refs: [{ entityId: S1, label: '스토리 하나' }, { entityId: S2, label: '스토리 둘' }] }]);
  });
});
