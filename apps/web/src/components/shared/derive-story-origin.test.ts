// story #2267(C-9) AC4/AC7 — 「출처」 판정 순수 함수. story-origin-section.tsx 마운트 없이
// 격리 검증(dep-picker-candidates.test.ts와 동일 관례).
import { describe, expect, it } from 'vitest';
import { deriveStoryOrigin } from './derive-story-origin';
import type { BacklinkItem } from './entity-backlinks-section';

function item(overrides: Partial<BacklinkItem>): BacklinkItem {
  return {
    id: 'r1',
    source_type: 'doc',
    source_id: 'd1',
    created_by: null,
    created_at: '2026-07-30T00:00:00Z',
    relation: 'none',
    still_exists: true,
    doc: null,
    message: null,
    meeting: null,
    story: null,
    ...overrides,
  };
}

describe('deriveStoryOrigin', () => {
  it('relation==="created_from"인 항목을 찾아 반환한다', () => {
    const origin = item({ id: 'origin', relation: 'created_from', doc: { id: 'd1', title: '출처 문서' } });
    expect(deriveStoryOrigin([item({ id: 'mention', relation: 'none' }), origin])).toBe(origin);
  });

  it('전부 relation==="none"이면 null — 빈 배열만으로 「출처 없음」을 단정하지 않는다(빈 배열도 null)', () => {
    expect(deriveStoryOrigin([item({ relation: 'none' }), item({ relation: 'none' })])).toBeNull();
    expect(deriveStoryOrigin([])).toBeNull();
  });

  it('AC7 계약: relation이 닫힌 2값 밖(미래 제3값)이어도 origin으로 오판하지 않는다 — 엄격 등호', () => {
    const unknownRelation = item({ relation: 'created_from' as BacklinkItem['relation'] });
    // TS union 밖 런타임 값이 들어와도(예: BE가 새 값을 보내는 미래) strict equality라 안전
    // — 여기서는 실제로 'created_from'을 준 케이스이므로 찾긴 하되, 값 자체가 다르면(any 캐스팅
    // 시나리오) 아래 케이스가 그 방어를 증명한다.
    const trulyUnknown = { ...item({}), relation: 'some_future_value' } as unknown as BacklinkItem;
    expect(deriveStoryOrigin([unknownRelation])).toBe(unknownRelation);
    expect(deriveStoryOrigin([trulyUnknown])).toBeNull();
  });

  it('여러 개 있으면 첫 번째(응답 순서, created_at DESC — 가장 최근)를 반환한다', () => {
    const first = item({ id: 'first', relation: 'created_from' });
    const second = item({ id: 'second', relation: 'created_from' });
    expect(deriveStoryOrigin([first, second])).toBe(first);
  });
});
