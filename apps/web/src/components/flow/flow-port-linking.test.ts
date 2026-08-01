import { describe, expect, it } from 'vitest';
import {
  resolveDeclareLinkCall, declareResponseToEdge, isValidPortDropTarget, resolveUndoTitle, PORT_LINK_KINDS,
} from './flow-port-linking';
import type { FlowMapEdge } from './derive-flow-map';

function makeEdge(overrides: Partial<FlowMapEdge> = {}): FlowMapEdge {
  return { fromNodeId: 'a', toNodeId: 'b', kind: null, confirmed: true, ...overrides };
}

describe('resolveDeclareLinkCall — 드래그 방향이 항상 A→B 화살표로 그려지게 API 방향을 계산한다', () => {
  it('spawned: API 호출 방향이 드래그 방향 그대로다(source=시작, target=끝)', () => {
    expect(resolveDeclareLinkCall('a', 'b', 'spawned')).toEqual({
      apiSourceId: 'a', targetId: 'b', relationKind: 'spawned',
    });
  });

  it('종류 미지정(null, "종류는 나중에"): spawned와 같은 방향(드래그 그대로)', () => {
    expect(resolveDeclareLinkCall('a', 'b', null)).toEqual({
      apiSourceId: 'a', targetId: 'b', relationKind: null,
    });
  });

  it('followed: API 호출 방향이 «뒤집힌다»(source=드래그 끝, target=드래그 시작) — 그래야 렌더 화살표가 A→B가 된다', () => {
    expect(resolveDeclareLinkCall('a', 'b', 'followed')).toEqual({
      apiSourceId: 'b', targetId: 'a', relationKind: 'followed',
    });
  });

  it('superseded: followed와 같은 이유로 뒤집힌다', () => {
    expect(resolveDeclareLinkCall('a', 'b', 'superseded')).toEqual({
      apiSourceId: 'b', targetId: 'a', relationKind: 'superseded',
    });
  });

  // 회귀 가드 — declareResponseToEdge와 짝을 이뤄 "드래그 A→B를 하면 항상 렌더 화살표도
  // fromNodeId=A, toNodeId=B다"를 3종 전부에서 값으로 닫는다(방향이 이 함수 하나에서만
  // 뒤집히므로 여기서 한 번 틀리면 캔버스 전체가 조용히 거꾸로 그려진다).
  it.each(PORT_LINK_KINDS)('%s: resolveDeclareLinkCall→declareResponseToEdge 왕복하면 항상 fromNodeId=드래그시작, toNodeId=드래그끝이다', (kind) => {
    const call = resolveDeclareLinkCall('drag-start', 'drag-end', kind);
    const edge = declareResponseToEdge(call.apiSourceId, {
      target_id: call.targetId, relation_kind: call.relationKind, status: 'declared',
    });
    expect(edge.fromNodeId).toBe('drag-start');
    expect(edge.toNodeId).toBe('drag-end');
    expect(edge.confirmed).toBe(true);
  });
});

describe('declareResponseToEdge', () => {
  it('kind=null 응답은 종 미정(null) 간선으로 변환된다', () => {
    const edge = declareResponseToEdge('a', { target_id: 'b', relation_kind: null, status: 'declared' });
    expect(edge.kind).toBeNull();
    expect(edge.fromNodeId).toBe('a');
    expect(edge.toNodeId).toBe('b');
  });

  it('status=declared 응답은 항상 confirmed=true 간선이다(사람이 만든 선은 실선이어야 한다, AC10)', () => {
    const edge = declareResponseToEdge('a', { target_id: 'b', relation_kind: 'spawned', status: 'declared' });
    expect(edge.confirmed).toBe(true);
  });
});

describe('isValidPortDropTarget — AC16(한 쌍에 관계는 하나) + 자기 자신 금지', () => {
  it('자기 자신은 놓을 수 없다', () => {
    expect(isValidPortDropTarget('a', 'a', [])).toBe(false);
  });

  it('아무 간선도 없으면 놓을 수 있다', () => {
    expect(isValidPortDropTarget('a', 'b', [])).toBe(true);
  });

  it('이미 A→B 간선이 있으면(같은 방향) 새로 못 잇는다', () => {
    const edges = [makeEdge({ fromNodeId: 'a', toNodeId: 'b' })];
    expect(isValidPortDropTarget('a', 'b', edges)).toBe(false);
  });

  it('이미 B→A 간선이 있으면(반대 방향) 그래도 못 잇는다 — 방향 무관, 관계 자체가 하나뿐', () => {
    const edges = [makeEdge({ fromNodeId: 'b', toNodeId: 'a' })];
    expect(isValidPortDropTarget('a', 'b', edges)).toBe(false);
  });

  it('관계없는 다른 쌍의 간선은 영향을 안 준다', () => {
    const edges = [makeEdge({ fromNodeId: 'x', toNodeId: 'y' })];
    expect(isValidPortDropTarget('a', 'b', edges)).toBe(true);
  });
});

// 유나 가디언 리뷰(2026-07-31, PR#2737) 회귀 가드 — 「막는다」고 문서만 적고 실제로는 안
// 막던 결함: 레인 A→B로 끌면 POST가 서버에 실제로 나가고 성공하는데(ok:true), target이
// 다른 레인이라 deriveFlowMapLane이 그 선을 못 그려 "성공했는데 화면은 조용한" 상태가 됐다.
describe('isValidPortDropTarget — 레인 간(목표↔목표) 잇기는 막는다(story #2224, goal-edges가 서기 전까지)', () => {
  it('레인 정보가 있고 서로 다른 레인이면 막는다(간선이 하나도 없어도)', () => {
    const laneIdByNodeId = new Map([['a', 'epic-1'], ['b', 'epic-2']]);
    expect(isValidPortDropTarget('a', 'b', [], laneIdByNodeId)).toBe(false);
  });

  it('레인 정보가 있고 같은 레인이면(기존 규칙 그대로) 놓을 수 있다', () => {
    const laneIdByNodeId = new Map([['a', 'epic-1'], ['b', 'epic-1']]);
    expect(isValidPortDropTarget('a', 'b', [], laneIdByNodeId)).toBe(true);
  });

  it('레인 정보를 아예 안 넘기면(단일-레인 호출부처럼) 검사를 건너뛴다 — 기존 동작 그대로', () => {
    expect(isValidPortDropTarget('a', 'b', [])).toBe(true);
  });

  it('한쪽 노드만 레인 정보가 있으면(알 수 없는 쪽) 막지 않는다 — 모르는 것을 «다르다»로 단정하지 않는다', () => {
    const laneIdByNodeId = new Map([['a', 'epic-1']]);
    expect(isValidPortDropTarget('a', 'b', [], laneIdByNodeId)).toBe(true);
  });
});

// 까심 QA 지적(2026-07-31, PR#2737) 회귀 가드 — 멀티레인의 findEpicIdForStoryId가
// now/upcoming만 검색해, 과거 노드가 얽히면 어느 레인 edges에 얹을지 못 찾는다. 그러면
// POST는 성공(ok:true)하는데 로컬 state가 조용히 안 바뀌어 "성공 토스트만 반짝하고 아무
// 흔적도 없는" 결함이 난다("실패가 조용하다"의 성공판) — 그 조합 자체를 미리 막는다.
describe('isValidPortDropTarget — 과거(past) 노드가 얽힌 잇기는 막는다', () => {
  it('드래그 시작이 과거 노드면 막는다', () => {
    const pastNodeIds = new Set(['a']);
    expect(isValidPortDropTarget('a', 'b', [], new Map(), pastNodeIds)).toBe(false);
  });

  it('대상이 과거 노드면 막는다', () => {
    const pastNodeIds = new Set(['b']);
    expect(isValidPortDropTarget('a', 'b', [], new Map(), pastNodeIds)).toBe(false);
  });

  it('둘 다 과거 노드면(까심 지적의 정확한 재현) 막는다', () => {
    const pastNodeIds = new Set(['a', 'b']);
    expect(isValidPortDropTarget('a', 'b', [], new Map(), pastNodeIds)).toBe(false);
  });

  it('과거 노드 정보를 아예 안 넘기면(단일-레인 호출부처럼) 검사를 건너뛴다 — 기존 동작 그대로', () => {
    expect(isValidPortDropTarget('a', 'b', [])).toBe(true);
  });

  it('둘 다 과거 노드가 아니면 이 검사는 관여 안 한다', () => {
    const pastNodeIds = new Set(['x']);
    expect(isValidPortDropTarget('a', 'b', [], new Map(), pastNodeIds)).toBe(true);
  });
});

// doc `flow-port-slot-spec` ㉣ v1.1 정정(유나 가디언 리뷰, issuecomment-5139439284) —
// 서명의 «누가»를 확認 없이 「내가」로 쓰지 않는다. declared_by/currentTeamMemberId 둘 다
// 있어야 「내가」/「{이름}이」로 확定하고, 그 외엔 전부 중립으로 떨어진다.
describe('resolveUndoTitle — declaredBy로 「내가/{이름}이/사람이 만든」을 가른다(확認 없이 「내가」로 단정하지 않는다)', () => {
  const memberMap = { 'me-1': { name: '미르코' }, 'other-2': { name: '디디' } };

  it('declaredBy가 나(currentTeamMemberId)와 같으면 "내가"', () => {
    expect(resolveUndoTitle('me-1', 'me-1', memberMap)).toEqual({ key: 'portUndoTitle' });
  });

  it('declaredBy가 다른 멤버이고 memberMap에 이름이 있으면 "{이름}이"', () => {
    expect(resolveUndoTitle('other-2', 'me-1', memberMap)).toEqual({ key: 'portUndoTitleOther', name: '디디' });
  });

  it('declaredBy가 null(BE가 누군지 안 남김)이면 중립 — "내가"로 단정하지 않는다', () => {
    expect(resolveUndoTitle(null, 'me-1', memberMap)).toEqual({ key: 'portUndoTitleUnknownAuthor' });
  });

  it('currentTeamMemberId가 아직 없으면(레이스) 중립 — 비교 자체를 안 한다', () => {
    expect(resolveUndoTitle('me-1', undefined, memberMap)).toEqual({ key: 'portUndoTitleUnknownAuthor' });
  });

  it('declaredBy는 있으나 memberMap에 이름이 없으면 중립 — "다른 사람"으로 지어내지 않는다', () => {
    expect(resolveUndoTitle('ghost-3', 'me-1', memberMap)).toEqual({ key: 'portUndoTitleUnknownAuthor' });
  });
});
