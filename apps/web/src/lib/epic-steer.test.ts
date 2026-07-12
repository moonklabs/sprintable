import { describe, expect, it } from 'vitest';
import { computeReorderPatch, type SteerEpic } from './epic-steer';

const e = (id: string, position?: number | null): SteerEpic => ({ id, position });

describe('computeReorderPatch (로드맵 조타 재정렬 → bulk PATCH diff·wedge #2)', () => {
  it('null 에픽을 맨 앞으로 끌면 그 항목만 position=1(나머지 null tail 유지·백필0)', () => {
    // 원래 [A,B,E] 전부 null → E를 idx0으로. reordered=[E,A,B], movedNewIndex=0.
    const patch = computeReorderPatch([e('E'), e('A'), e('B')], 0);
    expect(patch).toEqual([{ id: 'E', position: 1 }]);
  });

  it('null만 있는 목록에서 idx2로 끌면 prefix 0..2를 1,2,3으로 큐레이션(시각 순서 persist)', () => {
    const patch = computeReorderPatch([e('A'), e('B'), e('E')], 2);
    expect(patch).toEqual([
      { id: 'A', position: 1 },
      { id: 'B', position: 2 },
      { id: 'E', position: 3 },
    ]);
  });

  it('드롭 지점 아래에 이미 큐레이션된 항목이 있으면 cutoff가 거기까지 확장돼 renumber된다', () => {
    // idx3에 원래 position=5인 큐레이션. movedNewIndex=1 → cutoff=max(1,3)=3.
    const patch = computeReorderPatch([e('A'), e('X'), e('B'), e('C', 5)], 1);
    expect(patch).toEqual([
      { id: 'A', position: 1 },
      { id: 'X', position: 2 },
      { id: 'B', position: 3 },
      { id: 'C', position: 4 }, // 5→4로 정합
    ]);
  });

  it('prefix position이 이미 정확하면 그 항목은 diff에서 제외(최소 쓰기)', () => {
    const patch = computeReorderPatch([e('X', 1), e('Y', 2), e('Z')], 1);
    expect(patch).toEqual([]);
  });

  it('순수 null tail(cutoff 이후)은 절대 건드리지 않는다(백필0)', () => {
    // cur-1(pos1) 고정, 그 뒤 null 3개. movedNewIndex=0 → cutoff=0 → prefix만.
    const patch = computeReorderPatch([e('cur-1', 1), e('n1'), e('n2'), e('n3')], 0);
    expect(patch).toEqual([]); // 이미 pos1 정확 → 변경 0, tail 무손
  });
});
