/**
 * Tests for S-DOCS2 cross-parent D&D helpers
 *
 * isDescendant: pure function — safe to unit-test directly.
 * Drag guard logic mirrored by pure helpers below.
 */
import { describe, expect, it } from 'vitest';
import { compareDocsForSort, isDescendant } from './doc-tree';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function doc(id: string, parent_id: string | null, sort_order = 0, extra: { title?: string; updated_at?: string } = {}) {
  return { id, parent_id, title: extra.title ?? id, slug: id, icon: null, sort_order, updated_at: extra.updated_at };
}

// Tree:
//   root-a
//     child-a1
//       grandchild-a1a
//     child-a2
//   root-b
const DOCS = [
  doc('root-a', null, 0),
  doc('child-a1', 'root-a', 0),
  doc('grandchild-a1a', 'child-a1', 0),
  doc('child-a2', 'root-a', 1),
  doc('root-b', null, 1),
];

// ---------------------------------------------------------------------------
// isDescendant tests
// ---------------------------------------------------------------------------

describe('isDescendant', () => {
  it('returns true for direct child', () => {
    expect(isDescendant(DOCS, 'root-a', 'child-a1')).toBe(true);
  });

  it('returns true for grandchild (multi-level)', () => {
    expect(isDescendant(DOCS, 'root-a', 'grandchild-a1a')).toBe(true);
  });

  it('returns false for sibling', () => {
    expect(isDescendant(DOCS, 'child-a1', 'child-a2')).toBe(false);
  });

  it('returns false for ancestor (reverse direction)', () => {
    // child-a1 is NOT a descendant of grandchild-a1a
    expect(isDescendant(DOCS, 'child-a1', 'root-a')).toBe(false);
  });

  it('returns false for completely unrelated node', () => {
    expect(isDescendant(DOCS, 'root-a', 'root-b')).toBe(false);
  });

  it('returns false when nodeId does not exist', () => {
    expect(isDescendant(DOCS, 'root-a', 'nonexistent')).toBe(false);
  });

  it('returns false when ancestorId does not exist', () => {
    expect(isDescendant(DOCS, 'nonexistent', 'child-a1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drag guard helpers — mirror handleDragEnd logic in DocTree
// ---------------------------------------------------------------------------

type DragResult =
  | { action: 'same-parent-reorder' }
  | { action: 'cross-parent-move'; newParentId: string | null }
  | { action: 'blocked-circular' }
  | { action: 'blocked-no-permission' };

function simulateDrag(
  docs: ReturnType<typeof doc>[],
  activeId: string,
  overId: string,
  hasOnMove: boolean,
): DragResult {
  if (activeId === overId) throw new Error('same id — caller should skip');

  const activeDoc = docs.find((d) => d.id === activeId)!;
  const overDoc = docs.find((d) => d.id === overId)!;

  if (activeDoc.parent_id !== overDoc.parent_id) {
    if (isDescendant(docs, activeDoc.id, overDoc.id)) return { action: 'blocked-circular' };
    if (!hasOnMove) return { action: 'blocked-no-permission' };
    return { action: 'cross-parent-move', newParentId: overDoc.id };
  }

  return { action: 'same-parent-reorder' };
}

describe('drag guard logic', () => {
  it('same-parent drag → reorder', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'child-a2', true);
    expect(result.action).toBe('same-parent-reorder');
  });

  it('cross-parent drag with onMove → move to new parent', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'root-b', true);
    expect(result).toEqual({ action: 'cross-parent-move', newParentId: 'root-b' });
  });

  it('cross-parent drag without onMove → blocked (no-permission)', () => {
    const result = simulateDrag(DOCS, 'child-a1', 'root-b', false);
    expect(result.action).toBe('blocked-no-permission');
  });

  it('circular drag (drop into own subtree) → blocked', () => {
    // Dragging root-a into grandchild-a1a (a descendant)
    const result = simulateDrag(DOCS, 'root-a', 'grandchild-a1a', true);
    expect(result.action).toBe('blocked-circular');
  });

  it('dragging leaf into sibling subtree root → cross-parent move', () => {
    // child-a2 into root-b (different parent); root-b becomes the new parent
    const result = simulateDrag(DOCS, 'child-a2', 'root-b', true);
    expect(result).toEqual({ action: 'cross-parent-move', newParentId: 'root-b' });
  });
});

// ---------------------------------------------------------------------------
// compareDocsForSort — story #2167 트리 표시 정렬 (수동/이름순/수정일순)
// ---------------------------------------------------------------------------

describe('compareDocsForSort', () => {
  const zebra = doc('zebra', null, 2, { title: 'Zebra doc' });
  const apple = doc('apple', null, 0, { title: 'Apple doc' });
  const mango = doc('mango', null, 1, { title: 'Mango doc' });
  const SIBLINGS = [zebra, apple, mango]; // 삽입 순서 = manual sort_order와 무관하게 뒤섞임

  it("'manual' 모드는 sort_order 오름차순", () => {
    const sorted = [...SIBLINGS].sort((a, b) => compareDocsForSort(a, b, 'manual'));
    expect(sorted.map((d) => d.id)).toEqual(['apple', 'mango', 'zebra']);
  });

  it("'title' 모드는 이름순(sort_order 무관)", () => {
    const sorted = [...SIBLINGS].sort((a, b) => compareDocsForSort(a, b, 'title'));
    expect(sorted.map((d) => d.id)).toEqual(['apple', 'mango', 'zebra']);
  });

  it("'updated_at' 모드는 최근 수정 먼저", () => {
    const old = doc('old', null, 0, { updated_at: '2026-01-01T00:00:00Z' });
    const mid = doc('mid', null, 1, { updated_at: '2026-06-01T00:00:00Z' });
    const recent = doc('recent', null, 2, { updated_at: '2026-07-20T00:00:00Z' });
    const sorted = [old, recent, mid].sort((a, b) => compareDocsForSort(a, b, 'updated_at'));
    expect(sorted.map((d) => d.id)).toEqual(['recent', 'mid', 'old']);
  });

  it("'updated_at' 결측 문서는 최신 없음 취급으로 뒤로 밀린다", () => {
    const noDate = doc('no-date', null, 0);
    const hasDate = doc('has-date', null, 1, { updated_at: '2026-01-01T00:00:00Z' });
    const sorted = [noDate, hasDate].sort((a, b) => compareDocsForSort(a, b, 'updated_at'));
    expect(sorted.map((d) => d.id)).toEqual(['has-date', 'no-date']);
  });

  // ⭐PO 요구: "이름순/수정일순을 고르면 그 드래그 순서는 어떻게 되는가"를 실제로 확認할 것 —
  // 보기 전용이라 sort_order 값 자체는 절대 안 바뀌고, 'manual'로 돌아오면 원래 순서 그대로다.
  it('표시 정렬은 sort_order 값 자체를 바꾸지 않는다(비파괴) — title로 봤다가 manual로 돌아오면 원래 순서', () => {
    const originalSortOrders = SIBLINGS.map((d) => d.sort_order);

    // 'title' 모드로 "본다"(정렬만, 원본 배열이 아니라 복사본을 정렬)
    const viewedByTitle = [...SIBLINGS].sort((a, b) => compareDocsForSort(a, b, 'title'));
    // 원본 SIBLINGS의 sort_order는 전혀 안 바뀌었다.
    expect(SIBLINGS.map((d) => d.sort_order)).toEqual(originalSortOrders);
    expect(viewedByTitle.map((d) => d.sort_order)).toEqual([0, 1, 2]); // apple,mango,zebra의 sort_order

    // 'manual'로 돌아오면 — 여전히 원래 sort_order 기준 순서가 그대로 재현된다.
    const backToManual = [...SIBLINGS].sort((a, b) => compareDocsForSort(a, b, 'manual'));
    expect(backToManual.map((d) => d.id)).toEqual(['apple', 'mango', 'zebra']);
    expect(backToManual.map((d) => d.sort_order)).toEqual(originalSortOrders.slice().sort((x, y) => x - y));
  });
});
