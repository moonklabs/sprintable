// story #4353 — 끌기(재정렬 · 폴더로 옮기기)가 서버에 보내는 한 자리. 서버(`POST /api/v2/docs/reorder`)가 형제 번호를 안다 — 화면은
// «어느 부모 아래 · 어느 형제 뒤»만 정한다. `afterId`: 그 형제 바로 뒤 · `null` = 맨 앞 · `undefined`(보내지 않음) = 맨 끝.
// 형제 순서는 서버 목록과 같은 (sort_order, id) — sort_order 0 동률이 대부분이라 id로 끊어야 화면과 서버가 같은 줄을 본다.

export interface DocPlaceable {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

export interface DocMovePlan {
  docId: string;
  parentId: string | null;
  afterId?: string | null;
}

/** 서버 목록과 같은 (sort_order, id) 비교 — 형제 순서 · «⋮» 옮기기 고르개(story #4348)가 같은 비교를 쓴다. */
export function compareServerOrder(a: DocPlaceable, b: DocPlaceable): number {
  return a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function siblingsInServerOrder<T extends DocPlaceable>(docs: T[], parentId: string | null): T[] {
  return docs
    .filter((d) => d.parent_id === parentId)
    .sort(compareServerOrder);
}

/** 같은 부모 안 재정렬 — 끌기 라이브러리의 자리 바꾸기와 같은 뜻: 아래로 끌면 대상 뒤, 위로 끌면 대상 앞. */
export function planReorder(docs: DocPlaceable[], activeId: string, overId: string): DocMovePlan | null {
  const active = docs.find((d) => d.id === activeId);
  if (!active) return null;
  const siblings = siblingsInServerOrder(docs, active.parent_id);
  const from = siblings.findIndex((d) => d.id === activeId);
  const to = siblings.findIndex((d) => d.id === overId);
  if (from === -1 || to === -1 || from === to) return null;
  if (to > from) return { docId: activeId, parentId: active.parent_id, afterId: overId };
  const before = siblings.slice(0, to).filter((d) => d.id !== activeId);
  return { docId: activeId, parentId: active.parent_id, afterId: before.length ? before[before.length - 1]!.id : null };
}

/** 다른 부모의 문서 가장자리에 놓기 — 위쪽이면 그 문서 앞, 아래쪽이면 그 문서 뒤(그 문서의 부모 아래로 옮김). */
export function planMoveBeside(docs: DocPlaceable[], activeId: string, overId: string, side: 'before' | 'after'): DocMovePlan | null {
  const over = docs.find((d) => d.id === overId);
  if (!over) return null;
  if (side === 'after') return { docId: activeId, parentId: over.parent_id, afterId: overId };
  const siblings = siblingsInServerOrder(docs, over.parent_id).filter((d) => d.id !== activeId);
  const i = siblings.findIndex((d) => d.id === overId);
  return { docId: activeId, parentId: over.parent_id, afterId: i > 0 ? siblings[i - 1]!.id : null };
}

/** 폴더(문서) 안으로 — 그 부모의 맨 끝. `null` = 맨 위 단계의 맨 끝(«⋮» 옮기기 · story #4348). */
export function planMoveInto(activeId: string, parentId: string | null): DocMovePlan {
  return { docId: activeId, parentId };
}

/** 요청 본문 — `afterId`가 없으면 키 자체를 빼서 서버가 «맨 끝»으로 읽는다(null과 다름). */
export function reorderRequestBody(plan: DocMovePlan): Record<string, string | null> {
  const body: Record<string, string | null> = { doc_id: plan.docId, parent_id: plan.parentId };
  if (plan.afterId !== undefined) body.after_id = plan.afterId;
  return body;
}

// story #4366 — 끌어 떨굼 판정(유나 판정 표). 판정 상자 = **행**(하위 트리 아님). 폴더로 보이는 행(폴더 아이콘 · 펼침 화살표를 그리는 행):
// 위 25% 앞 · 가운데 50% 안(끝) · 아래 25% 뒤. 문서 행: 위 50% 앞 · 아래 50% 뒤(문서 안으로는 안 넣음 — 메뉴 «폴더로 이동…»도 폴더만 목적지).
export type DropZone = 'before' | 'into' | 'after';

export function dropZoneFor(relativeY: number, isFolderRow: boolean): DropZone {
  if (!isFolderRow) return relativeY < 0.5 ? 'before' : 'after';
  if (relativeY < 0.25) return 'before';
  if (relativeY > 0.75) return 'after';
  return 'into';
}

function isSelfOrDescendant(docs: DocPlaceable[], ancestorId: string, nodeId: string): boolean {
  const seen = new Set<string>();
  let current: string | null = nodeId;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = docs.find((d) => d.id === current)?.parent_id ?? null;
  }
  return false;
}

/**
 * 떨군 자리 → 서버에 보낼 한 자리. 표시(끄는 동안)와 결과(떨군 뒤)가 이 함수 하나에서 나온다 — «표시와 결과가 다름» 0.
 * 자기 자신 · 자기 하위(순환)면 null(표시 없음 · 떨궈도 무동작). 같은 부모 안도 앞/뒤는 표시 그대로(끌기 방향으로 뜻을 바꾸지 않음).
 */
export function planDrop(docs: DocPlaceable[], activeId: string, overId: string, zone: DropZone): DocMovePlan | null {
  if (!docs.some((d) => d.id === activeId) || !docs.some((d) => d.id === overId)) return null;
  if (isSelfOrDescendant(docs, activeId, overId)) return null;
  if (zone === 'into') return planMoveInto(activeId, overId);
  return planMoveBeside(docs, activeId, overId, zone);
}
