import { describe, expect, it } from 'vitest';
import { groupByIdenticalContent, referenceTypeLabel, type GenericGroupable } from './inbox-generic-notification-grouping';

function n(overrides: Partial<GenericGroupable> & { id: string }): GenericGroupable {
  return {
    type: 'gate.pending_approval',
    title: '결재 대기 중인 게이트가 있습니다',
    body: 'merge 게이트가 승인/거부를 기다리고 있습니다.',
    is_read: false,
    created_at: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('groupByIdenticalContent (story #0d1c69f3, v2 4호 — 제네릭 알림 그룹핑)', () => {
  it('같은 type+title+body(byte-identical) 2건 이상은 그룹으로 묶인다(라이브 121건 재현 축소판)', () => {
    const items = [n({ id: 'a' }), n({ id: 'b' }), n({ id: 'c' })];
    const { groups, ungrouped } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.notifications.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(ungrouped).toHaveLength(0);
  });

  it('1건뿐이면 그룹 대상이 아니다 — 개별 유지(AC3 회귀 가드, 카드홍수 방지)', () => {
    const items = [n({ id: 'solo' })];
    const { groups, ungrouped } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(0);
    expect(ungrouped.map((x) => x.id)).toEqual(['solo']);
  });

  it('title이나 body가 하나라도 다르면 별개 그룹(구체 알림은 개별 유지, story AC4)', () => {
    const items = [
      n({ id: 'a', title: '결재 대기 중인 게이트가 있습니다' }),
      n({ id: 'b', title: "문서 결재 요청: '2985 AC② 검증용 문서'" }),
      n({ id: 'c', body: '다른 본문' }),
    ];
    const { groups, ungrouped } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(0);
    expect(ungrouped).toHaveLength(3);
  });

  it('type이 다르면 title/body가 같아도 별개로 취급한다', () => {
    const items = [
      n({ id: 'a', type: 'gate.pending_approval' }),
      n({ id: 'b', type: 'gate.pending_approval(reopen)' }),
    ];
    const { groups, ungrouped } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(0);
    expect(ungrouped).toHaveLength(2);
  });

  it('body가 null인 항목끼리도 정확히 그룹핑된다(body 부재 자체가 하나의 값)', () => {
    const items = [n({ id: 'a', body: null }), n({ id: 'b', body: null })];
    const { groups } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(1);
  });

  it('여러 서로 다른 반복 문안이 각자 독립된 그룹으로 나뉜다', () => {
    const items = [
      n({ id: 'a', title: 'A 반복' }), n({ id: 'b', title: 'A 반복' }),
      n({ id: 'c', title: 'B 반복' }), n({ id: 'd', title: 'B 반복' }), n({ id: 'e', title: 'B 반복' }),
    ];
    const { groups } = groupByIdenticalContent(items);
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.notifications.length).sort();
    expect(sizes).toEqual([2, 3]);
  });
});

describe('referenceTypeLabel (story #0d1c69f3 — 구체 참조 칩 라벨)', () => {
  const t = (key: string) => ({
    referenceTypeGate: '게이트', referenceTypeStory: '스토리', referenceTypeDoc: '문서',
  } as Record<string, string>)[key] ?? key;

  it('알려진 reference_type은 매핑 라벨을 반환한다', () => {
    expect(referenceTypeLabel(t, 'gate')).toBe('게이트');
    expect(referenceTypeLabel(t, 'story')).toBe('스토리');
  });

  it('미상 reference_type은 지어내지 않고 원문 그대로 반환한다', () => {
    expect(referenceTypeLabel(t, 'some_new_type')).toBe('some_new_type');
  });

  it('null이면 null(칩 자체 미표시)', () => {
    expect(referenceTypeLabel(t, null)).toBeNull();
  });
});
