import { describe, expect, it } from 'vitest';
import {
  parseAttentionSignals,
  toExceptionQueueItems,
  type BeAttentionSignal,
  type ExceptionLabels,
} from './derive-exception-signals';

const LABELS: ExceptionLabels = {
  kind: { gate_pending: '승인 대기', blocked: '막힘', merge_ready: '병합 대기' },
  action: { gate_pending: '검토', blocked: '조율', merge_ready: '병합' },
};

/** 실 BE payload를 프록시(apiSuccess)가 감싼 형태 = `{data:{items}}`. */
function proxied(items: unknown[]): unknown {
  return { data: { items }, error: null, meta: null };
}

describe('parseAttentionSignals — AC1 shape-safety (형상 불일치는 crash 아닌 명시 생략)', () => {
  it('unwraps the proxy envelope {data:{items}} — the /api/activity-logs {items} 전례 회귀가드', () => {
    const json = proxied([
      { kind: 'gate_pending', story_id: 's1', title: '승인 필요 스토리', ref: { approval_id: 'ap1', gate_id: 'g1' } },
    ]);
    const out = parseAttentionSignals(json);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('gate_pending');
    expect(out[0]!.title).toBe('승인 필요 스토리');
  });

  it('also accepts the raw BE envelope {items} (프록시 미경유 방어)', () => {
    const out = parseAttentionSignals({ items: [{ kind: 'merge_ready', story_id: 's2', title: '리뷰 대기', ref: {} }] });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('merge_ready');
  });

  it('returns [] — not throw — when the payload is a bare array mistaken for the shape (wrong-shape guard)', () => {
    // 배열을 {items} 인 척 넘기던 게 전례의 근본. 배열이면 그대로 items로 관용 처리하되 crash 0.
    expect(() => parseAttentionSignals(proxied([]))).not.toThrow();
    expect(parseAttentionSignals({ data: [] })).toEqual([]);
    expect(parseAttentionSignals([])).toEqual([]);
  });

  it('returns [] for null / non-object / missing items (fetch 실패·형상 붕괴)', () => {
    expect(parseAttentionSignals(null)).toEqual([]);
    expect(parseAttentionSignals(undefined)).toEqual([]);
    expect(parseAttentionSignals('nope')).toEqual([]);
    expect(parseAttentionSignals({ data: {} })).toEqual([]);
    expect(parseAttentionSignals({ data: { items: 'not-array' } })).toEqual([]);
  });

  it('skips unknown kinds and malformed items (no-fiction) but keeps the valid ones', () => {
    const out = parseAttentionSignals(proxied([
      { kind: 'gate_pending', story_id: 's1', title: 'ok', ref: {} },
      { kind: 'exploded', story_id: 's2', title: 'unknown kind', ref: {} },
      'not-an-object',
      { story_id: 's3', title: 'no kind field', ref: {} },
      null,
    ]));
    expect(out.map((s) => s.title)).toEqual(['ok']);
  });

  it('drops items with no usable title — claim을 지어낼 수 없음(gate_pending story 미연결 케이스)', () => {
    const out = parseAttentionSignals(proxied([
      { kind: 'gate_pending', story_id: null, title: null, ref: { approval_id: 'ap9' } },
      { kind: 'blocked', story_id: 's4', title: '   ', ref: {} },
      { kind: 'merge_ready', story_id: 's5', title: '실제 제목', ref: {} },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('실제 제목');
  });

  it('coerces story_id/ref defensively (null story_id, missing ref)', () => {
    const out = parseAttentionSignals(proxied([
      { kind: 'blocked', story_id: null, title: 'x', ref: { blocker_story_id: 'b1' } },
      { kind: 'merge_ready', story_id: 's6', title: 'y' },
    ]));
    expect(out[0]!.story_id).toBeNull();
    expect(out[0]!.ref).toEqual({ blocker_story_id: 'b1' });
    expect(out[1]!.ref).toEqual({});
  });
});

describe('toExceptionQueueItems — 렌더 shape 매핑 + 정렬', () => {
  const signals: BeAttentionSignal[] = [
    { kind: 'merge_ready', story_id: 's-mr', title: '머지 대기 스토리', ref: {} },
    { kind: 'gate_pending', story_id: 's-gp', title: '승인 대기 스토리', ref: { approval_id: 'ap1' } },
    { kind: 'blocked', story_id: 's-bk', title: '막힌 스토리', ref: { blocker_story_id: 'b1' } },
  ];

  it('maps each kind to its label, proofState, tone and href', () => {
    const items = toExceptionQueueItems(signals, LABELS);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));

    expect(byKind['gate_pending']!.kindLabel).toBe('승인 대기');
    expect(byKind['gate_pending']!.proofState).toBe('amber');
    expect(byKind['gate_pending']!.actionLabel).toBe('검토');
    // gate_pending → 게이트 인박스(승인 표면), 개별 스토리 보드 아님.
    expect(byKind['gate_pending']!.href).toBe('/inbox?tab=gates');

    expect(byKind['blocked']!.href).toBe('/board?story=s-bk');
    expect(byKind['merge_ready']!.href).toBe('/board?story=s-mr');
    expect(byKind['merge_ready']!.proofState).toBe('green');
  });

  it('sorts amber signals (gate_pending·blocked) before green (merge_ready)', () => {
    const items = toExceptionQueueItems(signals, LABELS);
    expect(items[items.length - 1]!.kind).toBe('merge_ready');
    expect(items.slice(0, 2).map((i) => i.kind).sort()).toEqual(['blocked', 'gate_pending']);
  });

  it('actor is null (엔드포인트가 assignee 미포함 — 지어내지 않음) and sortKey 0 (타임스탬프 없음)', () => {
    const items = toExceptionQueueItems(signals, LABELS);
    expect(items.every((i) => i.actor === null)).toBe(true);
    expect(items.every((i) => i.sortKey === 0)).toBe(true);
  });

  it('produces stable unique ids', () => {
    const items = toExceptionQueueItems(signals, LABELS);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('gate-ap1');
    expect(ids).toContain('blocked-s-bk');
    expect(ids).toContain('merge-s-mr');
  });

  it('empty in → empty out (정직 빈 상태)', () => {
    expect(toExceptionQueueItems([], LABELS)).toEqual([]);
  });
});
