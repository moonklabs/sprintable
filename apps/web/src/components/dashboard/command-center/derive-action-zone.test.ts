// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectVisibleQueue, countChangedSince, countAttentionChangedSince, getLastSeenMs, markSeenNow } from './derive-action-zone';
import type { QueueItem, AttentionItem } from './types';

function item(type: QueueItem['type'], createdAt: string | null = null): QueueItem {
  return { type, priority: 'info', context: {}, created_at: createdAt };
}

function attentionItem(stuckSince: string | null = null): AttentionItem {
  return { type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 'e1', gate_type: null, stuck_since: stuckSince };
}

describe('selectVisibleQueue — story #2288 §7-4·§8-4', () => {
  it('cap 이하면 전부 보이고 잘림이 없다', () => {
    const queue = [item('review_merge'), item('gate_approval')];
    expect(selectVisibleQueue(queue, 5)).toEqual({ visible: queue, cutCount: 0 });
  });

  it('cap을 넘으면 review_merge부터 자른다(gate_approval·my_blockers는 보호)', () => {
    const queue = [
      item('review_merge'), item('review_merge'), item('review_merge'),
      item('gate_approval'), item('my_blockers'),
    ];
    const { visible, cutCount } = selectVisibleQueue(queue, 3);
    expect(cutCount).toBe(2);
    expect(visible).toHaveLength(3);
    expect(visible.filter((v) => v.type === 'review_merge')).toHaveLength(1);
    expect(visible.some((v) => v.type === 'gate_approval')).toBe(true);
    expect(visible.some((v) => v.type === 'my_blockers')).toBe(true);
  });

  it('보호 항목만으로도 cap을 넘으면 보호 항목은 자르지 않는다(자르지 않는다 규칙이 cap보다 우선)', () => {
    const queue = [item('gate_approval'), item('gate_approval'), item('my_blockers')];
    const { visible, cutCount } = selectVisibleQueue(queue, 2);
    expect(visible).toHaveLength(3);
    expect(cutCount).toBe(0);
  });

  it('원래 상대 순서를 보존한다(재정렬 아님, cuttable 중 뒤쪽부터 자른다 — BE가 이미 danger>warn>info로 정렬해 앞쪽이 더 급하다)', () => {
    const a = item('review_merge');
    const b = item('gate_approval');
    const c = item('review_merge');
    const { visible } = selectVisibleQueue([a, b, c], 2);
    expect(visible).toEqual([a, b]); // c(review_merge, cuttable 중 뒤쪽)가 잘리고, a·b는 원 순서 그대로
  });
});

describe('countChangedSince — story #2288 §8-8', () => {
  it('기준점이 없으면(첫 방문) 0 — 모름을 전부 새것으로 지어내지 않는다', () => {
    const queue = [item('review_merge', '2026-07-29T00:00:00Z')];
    expect(countChangedSince(queue, null)).toBe(0);
  });

  it('기준점 이후 생긴 항목만 센다', () => {
    const lastSeen = new Date('2026-07-29T00:00:00Z').getTime();
    const queue = [
      item('review_merge', '2026-07-28T23:00:00Z'), // 이전 — 안 셈
      item('gate_approval', '2026-07-29T01:00:00Z'), // 이후 — 셈
      item('my_blockers', null), // created_at 없음 — 안 셈
    ];
    expect(countChangedSince(queue, lastSeen)).toBe(1);
  });
});

describe('countAttentionChangedSince — story #2288, PO 확認(2026-07-29): §8-8을 attention까지 넓힘', () => {
  it('기준점이 없으면(첫 방문) 0', () => {
    expect(countAttentionChangedSince([attentionItem('2026-07-29T00:00:00Z')], null)).toBe(0);
  });

  it('stuck_since가 기준점 이후인 것만 센다(생겨난 시점으로 씀)', () => {
    const lastSeen = new Date('2026-07-29T00:00:00Z').getTime();
    const attention = [
      attentionItem('2026-07-28T23:00:00Z'), // 이전 — 안 셈
      attentionItem('2026-07-29T01:00:00Z'), // 이후 — 셈
      attentionItem(null), // 없음 — 안 셈
    ];
    expect(countAttentionChangedSince(attention, lastSeen)).toBe(1);
  });
});

describe('getLastSeenMs/markSeenNow — localStorage', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('쓰기 전엔 null', () => {
    expect(getLastSeenMs()).toBeNull();
  });

  it('markSeenNow 후 그 값을 그대로 읽는다', () => {
    markSeenNow(1234567890);
    expect(getLastSeenMs()).toBe(1234567890);
  });

  it('저장된 값이 손상되면(숫자 아님) null로 정직하게 취급한다', () => {
    store.set('sprintable:command-center:v1:last-seen-actions', 'not-a-number');
    expect(getLastSeenMs()).toBeNull();
  });
});
