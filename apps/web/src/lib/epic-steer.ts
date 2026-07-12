import type { EpicPositionItem } from '@sprintable/core-storage';

/** 재정렬 계산에 필요한 최소 형상(로드맵 조타·wedge #2). */
export interface SteerEpic {
  id: string;
  position?: number | null;
}

/**
 * 드래그 재정렬 → BE `PATCH /epics/bulk`로 보낼 `{id,position}` diff 산출.
 *
 * 모델(BE §1.3 · order_by=position = (position IS NULL) ASC, position ASC, created_at DESC):
 * 큐레이션(position≠null)은 **명시 prefix**(1..k)로 앞에 고정되고, 안 건드린 null tail은
 * created_at 순 자동도출로 뒤에 남는다. 어떤 항목을 시각적으로 null tail보다 앞에 두려면
 * 그 위쪽(0..지점) 전체가 큐레이션돼야 하므로 — cutoff까지 prefix를 1..k로 renumber한다.
 *
 * `cutoff = max(이동 항목의 새 인덱스, 원래 큐레이션돼 있던 최대 인덱스)`. cutoff 이후(순수
 * null tail)는 손대지 않는다(백필0). 반환은 **실제로 값이 바뀌는 항목만**(최소 쓰기).
 *
 * @param reordered arrayMove로 새 시각 순서가 반영된 배열(각 항목은 원래 position 보유)
 * @param movedNewIndex 이동한 항목의 새 인덱스
 */
export function computeReorderPatch(reordered: SteerEpic[], movedNewIndex: number): EpicPositionItem[] {
  let maxCuratedIdx = -1;
  reordered.forEach((e, i) => {
    if (e.position != null) maxCuratedIdx = i;
  });
  const cutoff = Math.max(movedNewIndex, maxCuratedIdx);

  const patch: EpicPositionItem[] = [];
  for (let i = 0; i <= cutoff; i++) {
    const e = reordered[i];
    if (!e) continue;
    const newPos = i + 1;
    if (e.position !== newPos) patch.push({ id: e.id, position: newPos });
  }
  return patch;
}
