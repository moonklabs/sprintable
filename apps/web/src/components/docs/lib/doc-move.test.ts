// story #4348 — 문서 옮기기 계산(키보드 · 터치 «⋮» 메뉴 · 끌기와 같은 결과). 저장 API와 무관한 순수 함수.
import { describe, expect, it } from 'vitest';
import { applyDocMove, docMoveAnnouncement, menuMoveState, moveBounds, moveTargets, placedFromSiblings, planDocMove, type MovableDoc, type MoveTarget } from './doc-move';
import { planMoveInto, planReorder, reorderRequestBody, siblingsInServerOrder } from '../doc-move-plan';

// 루트: a(0) · b(0) · c(0) — sort_order가 전부 0(대부분의 실데이터) · id로 갈림. f는 폴더(자식 f1 · f2), g는 f 안 폴더.
const DOCS: MovableDoc[] = [
  { id: 'c', parent_id: null, sort_order: 0, title: '셋째' },
  { id: 'a', parent_id: null, sort_order: 0, title: '첫째' },
  { id: 'b', parent_id: null, sort_order: 0, title: '둘째' },
  { id: 'f', parent_id: null, sort_order: 5, title: '폴더', is_folder: true },
  { id: 'f2', parent_id: 'f', sort_order: 2, title: '폴더 둘' },
  { id: 'f1', parent_id: 'f', sort_order: 1, title: '폴더 하나' },
  { id: 'g', parent_id: 'f', sort_order: 3, title: '안쪽 폴더', is_folder: true },
];
const ok = (p: ReturnType<typeof planDocMove>) => { if (!p.ok) throw new Error(p.reason); return p; };

describe('siblingsInServerOrder(doc-move-plan) — 서버와 같은 (sort_order, id)', () => {
  it('sort_order가 같으면 id 순 · 부모별로', () => {
    expect(siblingsInServerOrder(DOCS, null).map((d) => d.id)).toEqual(['a', 'b', 'c', 'f']);
    expect(siblingsInServerOrder(DOCS, 'f').map((d) => d.id)).toEqual(['f1', 'f2', 'g']);
  });
});

describe('moveBounds — 맨 위 «위로» · 맨 아래 «아래로» 끔', () => {
  it('맨 위 · 가운데 · 맨 아래 · 없는 문서', () => {
    expect(moveBounds(DOCS, 'a')).toEqual({ up: false, down: true });
    expect(moveBounds(DOCS, 'b')).toEqual({ up: true, down: true });
    expect(moveBounds(DOCS, 'f')).toEqual({ up: true, down: false });
    expect(moveBounds(DOCS, 'nope')).toEqual({ up: false, down: false });
  });
});

describe('planDocMove — 위로 · 아래로', () => {
  it('한 칸 위로 = 윗 형제와 바꿈 · 새 자리 index', () => {
    expect(ok(planDocMove(DOCS, 'c', { kind: 'up' }))).toMatchObject({ parentId: null, orderedIds: ['a', 'c', 'b', 'f'], index: 1 });
  });
  it('한 칸 아래로(폴더 안)', () => {
    expect(ok(planDocMove(DOCS, 'f1', { kind: 'down' }))).toMatchObject({ parentId: 'f', orderedIds: ['f2', 'f1', 'g'], index: 1 });
  });
  it('경계 — 맨 위에서 위로 · 맨 아래에서 아래로 거부', () => {
    expect(planDocMove(DOCS, 'a', { kind: 'up' })).toEqual({ ok: false, reason: 'boundary' });
    expect(planDocMove(DOCS, 'g', { kind: 'down' })).toEqual({ ok: false, reason: 'boundary' });
  });
});

describe('planDocMove — 폴더로', () => {
  it('폴더 끝에 붙인다 · 옛 부모 기록', () => {
    expect(ok(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'f' }))).toMatchObject({ fromParentId: null, parentId: 'f', orderedIds: ['f1', 'f2', 'g', 'a'], index: 3 });
  });
  it('맨 위 단계로(null)', () => {
    expect(ok(planDocMove(DOCS, 'f1', { kind: 'into', parentId: null }))).toMatchObject({ fromParentId: 'f', parentId: null, orderedIds: ['a', 'b', 'c', 'f', 'f1'] });
  });
  it('거부 — 같은 자리 · 폴더 아님 · 자기 자신 · 자기 아래(순환)', () => {
    expect(planDocMove(DOCS, 'f1', { kind: 'into', parentId: 'f' })).toEqual({ ok: false, reason: 'same-place' });
    expect(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'b' })).toEqual({ ok: false, reason: 'not-folder' });
    expect(planDocMove(DOCS, 'f', { kind: 'into', parentId: 'f' })).toEqual({ ok: false, reason: 'circular' });
    expect(planDocMove(DOCS, 'f', { kind: 'into', parentId: 'g' })).toEqual({ ok: false, reason: 'circular' });
    expect(planDocMove(DOCS, 'nope', { kind: 'up' })).toEqual({ ok: false, reason: 'not-found' });
  });
});

const row = (id: string | null, depth: number, current = false): MoveTarget => ({ id, depth, current });

describe('moveTargets — «폴더로 옮기기» 고르개(유나 #4730 확정: 트리 깊이 우선 · 들여쓰기)', () => {
  it('맨 위 단계(깊이 0)가 첫 줄 → 폴더를 부모 → 자식 차례로(맨 위 폴더 = 깊이 1) · 지금 있는 자리는 current로 남음 · 자기와 그 아래는 빠짐', () => {
    expect(moveTargets(DOCS, 'a')).toEqual([row(null, 0, true), row('f', 1), row('g', 2)]);
    expect(moveTargets(DOCS, 'f1')).toEqual([row(null, 0), row('f', 1, true), row('g', 2)]);
    expect(moveTargets(DOCS, 'f')).toEqual([row(null, 0, true)]); // 자기(f) 아래 g도 빠짐(순환)
    expect(moveTargets(DOCS, 'nope')).toEqual([]);
  });

  it('하위 폴더의 sort_order가 부모보다 작아도 부모 뒤에 온다(전체 sort_order 순이 아님) · 같은 이름도 부모 밑 깊이로 가린다', () => {
    const docs: MovableDoc[] = [
      { id: 'x', parent_id: null, sort_order: 0, title: '문서' },
      { id: 'plan', parent_id: null, sort_order: 5, title: '기획 폴더', is_folder: true },
      { id: 'sub', parent_id: 'plan', sort_order: 1, title: '하위 폴더', is_folder: true },
      { id: 'ops', parent_id: null, sort_order: 6, title: '운영', is_folder: true },
      { id: 'sub2', parent_id: 'ops', sort_order: 1, title: '하위 폴더', is_folder: true },
    ];
    expect(moveTargets(docs, 'x')).toEqual([row(null, 0, true), row('plan', 1), row('sub', 2), row('ops', 1), row('sub2', 2)]);
  });

  it('형제 비교는 트리 보기와 같은 비교를 받는다(이름순 보기 = 이름순)', () => {
    const docs: MovableDoc[] = [
      { id: 'x', parent_id: null, sort_order: 0, title: '문서' },
      { id: 'z', parent_id: null, sort_order: 1, title: '가 폴더', is_folder: true },
      { id: 'y', parent_id: null, sort_order: 2, title: '나 폴더', is_folder: true },
    ];
    const byTitle = (a: MovableDoc, b: MovableDoc) => b.title.localeCompare(a.title, 'ko'); // 일부러 거꾸로 — 받은 비교를 쓰는지 본다
    expect(moveTargets(docs, 'x').map((t) => t.id)).toEqual([null, 'z', 'y']);
    expect(moveTargets(docs, 'x', byTitle).map((t) => t.id)).toEqual([null, 'y', 'z']);
  });

  it('트리에 안 보이는 폴더(부모를 아직 안 받음)는 빠진다', () => {
    const docs: MovableDoc[] = [
      { id: 'x', parent_id: null, sort_order: 0, title: '문서' },
      { id: 'orphan', parent_id: 'not-loaded', sort_order: 0, title: '고아', is_folder: true },
    ];
    expect(moveTargets(docs, 'x')).toEqual([row(null, 0, true)]);
  });
});

describe('placedFromSiblings — 저장 응답으로 센 자리(까디르 #4730 P3)', () => {
  it('응답 형제 전부 중 (sort_order, id) 순서 자리 · 형제 수 — 옮긴 문서가 목록에 없으면 doc을 넣어 셈', () => {
    const sibs = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 2 }, { id: 'c', sort_order: 3 }, { id: 'd', sort_order: 4 }, { id: 'e', sort_order: 5 }];
    expect(placedFromSiblings({ id: 'b', sort_order: 2 }, sibs)).toEqual({ position: 2, total: 5 });
    expect(placedFromSiblings({ id: 'x', sort_order: 3 }, sibs)).toEqual({ position: 4, total: 6 }); // 같은 번호면 id 순: c < x → x는 넷째
    expect(placedFromSiblings({ id: 'a', sort_order: 9 }, [])).toEqual({ position: 1, total: 1 });
  });
});

describe('reorderRequestBody — 저장 본문 {doc_id, parent_id, after_id?}(4353 모양 (가))', () => {
  it('위로 = 새 자리 바로 앞 형제 뒤 · 맨 앞으로면 after_id null', () => {
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'c', { kind: 'up' })).placement)).toEqual({ doc_id: 'c', parent_id: null, after_id: 'a' }); // a · c · b · f
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'b', { kind: 'up' })).placement)).toEqual({ doc_id: 'b', parent_id: null, after_id: null }); // b · a · c · f
  });
  it('아래로 = 다음 형제 뒤', () => {
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'f1', { kind: 'down' })).placement)).toEqual({ doc_id: 'f1', parent_id: 'f', after_id: 'f2' });
  });
  it('폴더로 · 맨 위 단계로 = after_id 키 없음(서버의 진짜 맨 끝)', () => {
    const into = reorderRequestBody(ok(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'f' })).placement);
    expect(into).toEqual({ doc_id: 'a', parent_id: 'f' });
    expect('after_id' in into).toBe(false);
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'f1', { kind: 'into', parentId: null })).placement)).toEqual({ doc_id: 'f1', parent_id: null });
  });
});

describe('applyDocMove — 로컬 트리 낙관 반영', () => {
  it('새 부모 · 간격 번호 · 다른 부모의 문서는 그대로', () => {
    const out = applyDocMove(DOCS, ok(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'f' })));
    expect(siblingsInServerOrder(out, 'f').map((d) => d.id)).toEqual(['f1', 'f2', 'g', 'a']);
    expect(siblingsInServerOrder(out, null).map((d) => d.id)).toEqual(['b', 'c', 'f']);
    expect(out.find((d) => d.id === 'b')).toBe(DOCS.find((d) => d.id === 'b'));
  });
});

describe('docMoveAnnouncement — 옮긴 뒤 aria-live 알림(키 · 값)', () => {
  it('위로 · 아래로 = 서버 자리를 알면 «N개 중 M번째»(N = 응답 형제 전부 · 불러온 수 아님)', () => {
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'c', { kind: 'up' })), { position: 2, total: 37 })).toEqual({ kind: 'position', values: { title: '셋째', position: 2, total: 37 } });
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'f1', { kind: 'down' })), { position: 2, total: 3 })).toEqual({ kind: 'position', values: { title: '폴더 하나', position: 2, total: 3 } });
  });
  it('서버 자리를 모르면 «M번째»만(불러온 형제 수로 전체를 단정하지 않음)', () => {
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'c', { kind: 'up' })))).toEqual({ kind: 'positionOnly', values: { title: '셋째', position: 2 } });
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'c', { kind: 'up' })), null)).toEqual({ kind: 'positionOnly', values: { title: '셋째', position: 2 } });
  });
  it('폴더로 = 새 폴더 이름 · 맨 위 단계로 = 단계만', () => {
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'g' })))).toEqual({ kind: 'intoFolder', values: { title: '첫째', folder: '안쪽 폴더' } });
    expect(docMoveAnnouncement(DOCS, ok(planDocMove(DOCS, 'f1', { kind: 'into', parentId: null })))).toEqual({ kind: 'topLevel', values: { title: '폴더 하나' } });
  });
});

describe('menuMoveState — «⋮» 메뉴 항목 상태(정렬 모드 · 경계 · 폴더)', () => {
  it('수동 보기: 경계만 끔 · 폴더 목록', () => {
    expect(menuMoveState(DOCS, 'b', 'manual')).toEqual({ up: true, down: true, sortLocked: false, downUnloaded: false, targets: [row(null, 0, true), row('f', 1), row('g', 2)] });
    expect(menuMoveState(DOCS, 'a', 'manual')).toMatchObject({ up: false, down: true, sortLocked: false });
  });
  it('이름순 · 수정일순: 위로 · 아래로 끔(까닭 = 정렬) · 폴더로는 그대로', () => {
    expect(menuMoveState(DOCS, 'b', 'title')).toEqual({ up: false, down: false, sortLocked: true, downUnloaded: false, targets: [row(null, 0, true), row('f', 1), row('g', 2)] });
    expect(menuMoveState(DOCS, 'b', 'updated_at')).toMatchObject({ up: false, down: false, sortLocked: true });
  });
});

describe('menuMoveState — 아직 안 받은 문서가 있을 때(20개씩 페이지)', () => {
  it('받은 형제 중 마지막이면 아래로 끔(다음 형제가 안 받은 자리일 수 있음) · 가운데는 그대로 · 다 받았으면 경계 규칙만', () => {
    expect(menuMoveState(DOCS, 'f', 'manual', true)).toMatchObject({ down: false, downUnloaded: true });
    expect(menuMoveState(DOCS, 'b', 'manual', true)).toMatchObject({ down: true, downUnloaded: false });
    expect(menuMoveState(DOCS, 'f', 'manual', false)).toMatchObject({ down: false, downUnloaded: false });
    expect(menuMoveState(DOCS, 'f', 'title', true)).toMatchObject({ down: false, downUnloaded: false, sortLocked: true });
  });
});

// story #4348 × 4353 — 끌기 길과 «⋮» 메뉴 길이 **같은 요청 본문**을 보낸다(계획 모듈 한 곳 · doc-move-plan.ts). 한쪽 계획이 바뀌면 여기가 빨개진다.
describe('같은 길 — 메뉴 옮기기 본문 = 끌기 계획 본문', () => {
  it('아래로 = 다음 형제 위에 끌어 놓기 · 위로 = 앞 형제 위에 끌어 놓기 · 폴더로 = 폴더 안으로 끌기', () => {
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'b', { kind: 'down' })).placement)).toEqual(reorderRequestBody(planReorder(DOCS, 'b', 'c')!));
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'c', { kind: 'up' })).placement)).toEqual(reorderRequestBody(planReorder(DOCS, 'c', 'b')!));
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'f1', { kind: 'down' })).placement)).toEqual(reorderRequestBody(planReorder(DOCS, 'f1', 'f2')!));
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'a', { kind: 'into', parentId: 'f' })).placement)).toEqual(reorderRequestBody(planMoveInto('a', 'f')));
    expect(reorderRequestBody(ok(planDocMove(DOCS, 'f1', { kind: 'into', parentId: null })).placement)).toEqual(reorderRequestBody(planMoveInto('f1', null)));
  });
});
