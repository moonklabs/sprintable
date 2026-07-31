import { describe, expect, it } from 'vitest';
import {
  resolveDeclareLinkCall, declareResponseToEdge, isValidPortDropTarget, PORT_LINK_KINDS,
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
