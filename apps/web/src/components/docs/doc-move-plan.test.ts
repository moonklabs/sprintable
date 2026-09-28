import { describe, expect, it } from 'vitest';
import { dropZoneFor, planDrop, planMoveBeside, planMoveInto, planReorder, reorderRequestBody, siblingsInServerOrder } from './doc-move-plan';

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

// story #4366 — 끌어 떨굼 판정(유나 판정 표) · 표시와 결과가 한 함수.
describe('dropZoneFor — 행 기준 구간', () => {
  it('폴더 행: 위 25% 앞 · 가운데 50% 안 · 아래 25% 뒤', () => {
    expect(dropZoneFor(0.1, true)).toBe('before');
    expect(dropZoneFor(0.25, true)).toBe('into');
    expect(dropZoneFor(0.5, true)).toBe('into');
    expect(dropZoneFor(0.75, true)).toBe('into');
    expect(dropZoneFor(0.9, true)).toBe('after');
  });
  it('문서 행: 위 50% 앞 · 아래 50% 뒤 — «안으로» 없음', () => {
    expect(dropZoneFor(0.1, false)).toBe('before');
    expect(dropZoneFor(0.49, false)).toBe('before');
    expect(dropZoneFor(0.5, false)).toBe('after');
    expect(dropZoneFor(0.9, false)).toBe('after');
  });
});

describe('planDrop', () => {
  const tree = [
    { id: 'F', parent_id: null, sort_order: 0 },
    { id: 'c1', parent_id: 'F', sort_order: 0 },
    { id: 'c2', parent_id: 'F', sort_order: 1 },
    { id: 'a', parent_id: null, sort_order: 1 },
  ];
  it('안 = 그 폴더 끝(after_id 없음) · 앞/뒤 = 그 행 옆', () => {
    expect(planDrop(tree, 'a', 'F', 'into')).toEqual({ docId: 'a', parentId: 'F' });
    expect(planDrop(tree, 'a', 'F', 'before')).toEqual({ docId: 'a', parentId: null, afterId: null });
    expect(planDrop(tree, 'a', 'F', 'after')).toEqual({ docId: 'a', parentId: null, afterId: 'F' });
    expect(planDrop(tree, 'a', 'c1', 'after')).toEqual({ docId: 'a', parentId: 'F', afterId: 'c1' });
  });
  it('같은 부모 안도 표시 그대로(끌기 방향으로 뜻을 바꾸지 않음) — 위로 끌어 «뒤»면 뒤', () => {
    expect(planDrop(tree, 'c2', 'c1', 'after')).toEqual({ docId: 'c2', parentId: 'F', afterId: 'c1' });
    expect(planDrop(tree, 'c1', 'c2', 'before')).toEqual({ docId: 'c1', parentId: 'F', afterId: null });
  });
  it('자기 자신 · 자기 하위(순환) = null(표시 없음 · 무동작)', () => {
    expect(planDrop(tree, 'F', 'F', 'into')).toBeNull();
    expect(planDrop(tree, 'F', 'c1', 'into')).toBeNull();
    expect(planDrop(tree, 'F', 'c1', 'after')).toBeNull();
    expect(planDrop(tree, 'zz', 'F', 'into')).toBeNull();
  });
});
