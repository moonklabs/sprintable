import { describe, expect, it } from 'vitest';
import { planMoveBeside, planMoveInto, planReorder, reorderRequestBody, siblingsInServerOrder } from './doc-move-plan';

// story #4353 — dev 현실: 형제 sort_order가 전부 0. 순서는 (sort_order, id) — 서버 목록과 같다.
const docs = [
  { id: 'a', parent_id: null, sort_order: 0 },
  { id: 'b', parent_id: null, sort_order: 0 },
  { id: 'c', parent_id: null, sort_order: 0 },
  { id: 'd', parent_id: null, sort_order: 0 },
  { id: 'f1', parent_id: 'd', sort_order: 0 },
  { id: 'f2', parent_id: 'd', sort_order: 0 },
];

describe('doc-move-plan — 끌기가 서버에 보내는 한 자리', () => {
  it('⭐동률 형제는 id로 끊어 서버와 같은 줄을 본다', () => {
    expect(siblingsInServerOrder(docs, null).map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('⭐아래로 끌면 대상 바로 뒤', () => {
    expect(planReorder(docs, 'a', 'c')).toEqual({ docId: 'a', parentId: null, afterId: 'c' });
  });

  it('⭐위로 끌면 대상 앞 = 대상의 앞 형제 뒤 · 맨 앞 대상이면 null(맨 앞)', () => {
    expect(planReorder(docs, 'd', 'b')).toEqual({ docId: 'd', parentId: null, afterId: 'a' });
    expect(planReorder(docs, 'c', 'a')).toEqual({ docId: 'c', parentId: null, afterId: null });
  });

  it('같은 자리 · 모르는 문서는 보낼 것이 없다', () => {
    expect(planReorder(docs, 'a', 'a')).toBeNull();
    expect(planReorder(docs, 'zz', 'a')).toBeNull();
  });

  it('⭐다른 부모 문서의 위쪽 가장자리 = 그 문서 앞 · 아래쪽 = 그 문서 뒤(그 부모 아래로)', () => {
    expect(planMoveBeside(docs, 'a', 'f2', 'before')).toEqual({ docId: 'a', parentId: 'd', afterId: 'f1' });
    expect(planMoveBeside(docs, 'a', 'f1', 'before')).toEqual({ docId: 'a', parentId: 'd', afterId: null });
    expect(planMoveBeside(docs, 'a', 'f1', 'after')).toEqual({ docId: 'a', parentId: 'd', afterId: 'f1' });
  });

  it('⭐폴더 안으로 = 맨 끝 — 요청 본문에 after_id 키가 없다(null이면 맨 앞이 된다)', () => {
    const plan = planMoveInto('a', 'd');
    expect(plan).toEqual({ docId: 'a', parentId: 'd' });
    expect(reorderRequestBody(plan)).toEqual({ doc_id: 'a', parent_id: 'd' });
    expect('after_id' in reorderRequestBody(plan)).toBe(false);
    expect(reorderRequestBody({ docId: 'a', parentId: null, afterId: null })).toEqual({ doc_id: 'a', parent_id: null, after_id: null });
  });
});
