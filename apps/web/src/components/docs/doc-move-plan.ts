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

export function siblingsInServerOrder<T extends DocPlaceable>(docs: T[], parentId: string | null): T[] {
  return docs
    .filter((d) => d.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/** 폴더(문서) 안으로 — 그 부모의 맨 끝. */
export function planMoveInto(activeId: string, parentId: string): DocMovePlan {
  return { docId: activeId, parentId };
}

/** 요청 본문 — `afterId`가 없으면 키 자체를 빼서 서버가 «맨 끝»으로 읽는다(null과 다름). */
export function reorderRequestBody(plan: DocMovePlan): Record<string, string | null> {
  const body: Record<string, string | null> = { doc_id: plan.docId, parent_id: plan.parentId };
  if (plan.afterId !== undefined) body.after_id = plan.afterId;
  return body;
}
