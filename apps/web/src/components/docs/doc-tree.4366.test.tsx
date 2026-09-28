// @vitest-environment jsdom
//
// story #4366(유나 실측) — 펼친 폴더 **행 가운데**에 떨궈도 폴더 안으로 안 들어갔다: 끌 대상 상자가 폴더 행이 아니라 자식까지 감싼
// 하위 트리 전체라 폴더 행은 그 상자의 위 25% 안 → 늘 «앞/뒤». 이제 상자 = 행 · 끄는 동안 표시(삽입선 / «안으로» 칠+테두리) ·
// 떨군 결과 = 그 표시(한 판정 함수). jsdom은 배치를 안 한다 → 사각형을 **그 끌 대상 상자가 담은 행 수**로 준다(행 하나 32px ·
// 문서 순서대로 쌓임). 상자가 하위 트리로 돌아가면 폴더 상자 높이가 자식 행만큼 커져 같은 포인터가 «앞»으로 읽힌다(뮤테이션 RED).
// dnd-kit 실 포인터 제스처 선례가 없어(kanban-board.test.tsx와 같은 이유) DndContext만 바꿔 끼워 onDragMove · onDragEnd를 쥔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree, pointerRowCollision } from './doc-tree';
import type { DocMovePlan } from './doc-move-plan';

type Handler = (event: unknown) => unknown;
const handlers: { move?: Handler; end?: Handler; collide?: Handler } = {};
// 유나(4752) — 복제 그림만 아래로. DragOverlay가 받은 props(특히 modifiers)를 쥔다.
const overlay: { modifiers?: unknown; className?: string } = {};
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ onDragStart, onDragMove, onDragEnd, collisionDetection, children }: { onDragStart?: Handler; onDragMove?: Handler; onDragEnd?: Handler; collisionDetection?: Handler; children?: React.ReactNode }) => {
      (handlers as { start?: Handler }).start = onDragStart;
      handlers.collide = collisionDetection;
      handlers.move = onDragMove;
      handlers.end = onDragEnd;
      return <>{children}</>;
    },
    DragOverlay: ({ modifiers, className, children }: { modifiers?: unknown; className?: string; children?: React.ReactNode }) => {
      overlay.modifiers = modifiers;
      overlay.className = className;
      return <div data-overlay-root>{children}</div>;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 32;
let container: HTMLDivElement;
let root: Root;
let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const d = (id: string, parent_id: string | null, sort_order: number, is_folder = false) => ({ id, parent_id, title: id, slug: id, icon: null, sort_order, is_folder });
//   F(펼침) ─ c1 · c2      a(문서)
const DOCS = [d('F', null, 0, true), d('c1', 'F', 0), d('c2', 'F', 1), d('a', null, 1)];

async function mount(docs = DOCS, saved = true) {
  const onMove = vi.fn<(plan: DocMovePlan) => Promise<boolean>>(async () => saved);
  const onReorder = vi.fn<(plan: DocMovePlan) => Promise<boolean>>(async () => saved);
  const onMoveDenied = vi.fn();
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocTree docs={docs} selectedSlug={null} onSelect={() => {}} onMove={onMove} onReorder={onReorder} onMoveDenied={onMoveDenied} projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
  return { onMove, onReorder, onMoveDenied };
}

const rowButtons = () => Array.from(container.querySelectorAll<HTMLElement>('button[data-doc-id]'));
/** 끌 대상으로 등록된 상자의 사각형 = 그 상자가 담은 행들(문서 순서대로 32px씩). 실제 dnd-kit가 over.rect로 재는 그 상자. */
function dropBoxRect(id: string) {
  const box = container.querySelector<HTMLElement>(`[data-drop-target="${id}"]`)!;
  const all = rowButtons();
  const inside = all.filter((b) => box.contains(b));
  const top = all.indexOf(inside[0]!) * ROW;
  return { top, height: inside.length * ROW, left: 0, width: 264, bottom: top + inside.length * ROW, right: 264 };
}
/** 포인터를 화면 y에 두고 over 행 위로(유나 4752 — 판정은 포인터로만). dnd-kit처럼 충돌 함수가 먼저 pointerCoordinates(화면 좌표)를 받고,
 * 그 뒤 move/end 이벤트가 온다. delta는 dnd-kit 그대로 «이동 + 끌기 시작 뒤 스크롤 이동량(scrolled)»(core.esm.js:2983) — 판정이 delta를 읽으면 스크롤 때 깨진다.
 * translated(그린 복제의 사각형)는 일부러 엉뚱한 곳(아래로 500px)에 둔다 — 판정이 그것을 읽으면 테스트가 깨진다. */
const START_Y = 5;
function dragEvent(activeId: string, overId: string, y: number, scrolled = 0, translatedTop = y + 500) {
  return {
    active: { id: activeId, rect: { current: { translated: { top: translatedTop, height: ROW } } } },
    over: { id: overId, rect: dropBoxRect(overId) },
    activatorEvent: new MouseEvent('pointerdown', { clientX: 10, clientY: START_Y }),
    delta: { x: 0, y: y - START_Y + scrolled },
  };
}
function pointerAt(y: number) {
  handlers.collide?.({ pointerCoordinates: { x: 10, y }, droppableRects: new Map(), droppableContainers: [], active: null, collisionRect: null });
}
const rowTop = (id: string) => rowButtons().findIndex((b) => b.dataset.docId === id) * ROW;
async function move(activeId: string, overId: string, y: number, scrolled = 0) { await act(async () => { pointerAt(y); handlers.move?.(dragEvent(activeId, overId, y, scrolled)); }); }
// 실 끌기처럼 그 자리로 움직여(표시가 그려진 뒤) 놓는다 — 놓을 때는 마지막으로 그린 표시를 쓴다(까디르 4752).
async function drop(activeId: string, overId: string, y: number, scrolled = 0) {
  await move(activeId, overId, y, scrolled);
  await act(async () => { pointerAt(y); await handlers.end?.(dragEvent(activeId, overId, y, scrolled)); });
}
const zones = () => Array.from(container.querySelectorAll<HTMLElement>('[data-drop-zone]')).map((b) => `${b.dataset.docId}:${b.dataset.dropZone}`);
const lines = () => Array.from(container.querySelectorAll<HTMLElement>('[data-drop-line]'));

describe('DocTree 끌어 떨굼 — 상자 = 행 · 표시 = 결과(story #4366)', () => {
  it('⭐끌 대상 상자는 폴더 **행**이다 — 자식 행을 담지 않는다', async () => {
    await mount();
    const box = container.querySelector('[data-drop-target="F"]')!;
    expect(box.contains(container.querySelector('button[data-doc-id="F"]'))).toBe(true);
    expect(box.contains(container.querySelector('button[data-doc-id="c1"]'))).toBe(false);
  });

  it('⭐펼친 폴더 행 가운데 → 그 폴더 안(끝) · 끄는 동안 «안으로» 표시 하나(삽입선 0)', async () => {
    const { onMove } = await mount();
    const y = rowTop('F') + ROW / 2;
    await move('a', 'F', y);
    expect(zones()).toEqual(['F:into']);
    expect(lines()).toHaveLength(0);
    expect(container.querySelector('button[data-doc-id="F"]')!.className).toContain('ring-primary');
    await drop('a', 'F', y);
    expect(onMove).toHaveBeenCalledWith({ docId: 'a', parentId: 'F' });
    expect(zones()).toEqual([]);
  });

  it('⭐폴더 행 위 가장자리 → 그 행 앞(삽입선 위) · 아래 가장자리 → 뒤(선은 하위 트리 끝)', async () => {
    const { onReorder } = await mount();
    await move('a', 'F', rowTop('F') + 4);
    expect(lines().map((l) => l.dataset.dropLine)).toEqual(['top']);
    expect(zones()).toEqual(['F:before']);
    await drop('a', 'F', rowTop('F') + 4);
    expect(onReorder).toHaveBeenLastCalledWith({ docId: 'a', parentId: null, afterId: null });

    await move('a', 'F', rowTop('F') + ROW - 4);
    const [line] = lines();
    expect(lines()).toHaveLength(1);
    expect(zones()).toEqual(['F:after']);
    // 선이 폴더 행 바로 아래가 아니라 자식들(c2) 아래 — 선이 가리키는 곳 = 실제로 들어가는 곳(F 다음 형제 자리).
    expect(line!.compareDocumentPosition(container.querySelector('button[data-doc-id="c2"]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(container.querySelector('[data-drop-target="F"]')!.contains(line!)).toBe(false);
    await drop('a', 'F', rowTop('F') + ROW - 4);
    expect(onReorder).toHaveBeenLastCalledWith({ docId: 'a', parentId: null, afterId: 'F' });
  });

  it('⭐문서 행은 «안으로» 없음 — 위 절반 앞 · 아래 절반 뒤(가운데여도)', async () => {
    const { onMove } = await mount();
    await move('a', 'c1', rowTop('c1') + ROW / 2 + 1);
    expect(zones()).toEqual(['c1:after']);
    expect(lines().map((l) => l.dataset.dropLine)).toEqual(['bottom']);
    await drop('a', 'c1', rowTop('c1') + ROW / 2 + 1);
    expect(onMove).toHaveBeenLastCalledWith({ docId: 'a', parentId: 'F', afterId: 'c1' });
    await drop('a', 'c1', rowTop('c1') + 4);
    expect(onMove).toHaveBeenLastCalledWith({ docId: 'a', parentId: 'F', afterId: null });
  });

  it('⭐자기 하위 위(순환)는 표시 없음 · 떨궈도 무동작 + circular 알림', async () => {
    const { onMove, onReorder, onMoveDenied } = await mount();
    await move('F', 'c1', rowTop('c1') + 4);
    expect(zones()).toEqual([]);
    expect(lines()).toHaveLength(0);
    await drop('F', 'c1', rowTop('c1') + 4);
    expect(onMove).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
    expect(onMoveDenied).toHaveBeenCalledWith('circular');
  });

  it('⭐끄는 동안 다른 행은 움직이지 않는다(자리 비키기 transform 0)', async () => {
    await mount();
    await move('a', 'F', rowTop('F') + ROW / 2);
    for (const box of Array.from(container.querySelectorAll<HTMLElement>('[data-drop-target]'))) {
      expect(box.parentElement!.style.transform).toBe('');
      expect(box.style.transform).toBe('');
    }
  });

  it('⭐접힌 폴더 «안으로» 떨구면 그 폴더를 펼친다 — 옮긴 문서가 폴더 끝에 보이게', async () => {
    store.set('docs:tree:expanded:p1', JSON.stringify(['G']));
    const docs = [d('G', null, 0, true), d('g1', 'G', 0), d('a', null, 1)];
    const { onMove } = await mount(docs);
    expect(container.querySelector('button[data-doc-id="g1"]')).toBeNull();
    await drop('a', 'G', rowTop('G') + ROW / 2);
    expect(onMove).toHaveBeenCalledWith({ docId: 'a', parentId: 'G' });
    expect(JSON.parse(store.get('docs:tree:expanded:p1')!)).toEqual([]);
    expect(container.querySelector('button[data-doc-id="g1"]')).not.toBeNull();
  });

  it('⭐저장이 실패하면(문서 제자리) 접힌 폴더를 펼치지 않는다 — 까디르(4752)', async () => {
    store.set('docs:tree:expanded:p1', JSON.stringify(['G']));
    const docs = [d('G', null, 0, true), d('g1', 'G', 0), d('a', null, 1)];
    const { onMove } = await mount(docs, false);
    await drop('a', 'G', rowTop('G') + ROW / 2);
    expect(onMove).toHaveBeenCalledWith({ docId: 'a', parentId: 'G' });
    expect(JSON.parse(store.get('docs:tree:expanded:p1')!)).toEqual(['G']);
    expect(container.querySelector('button[data-doc-id="g1"]')).toBeNull();
  });

  // 유나(4752) — 복제가 겨눈 행을 가렸다 → 오버레이 전체를 한 행 간격(36px) 아래로 · 누름 통과. 판정은 포인터라 무관(아래 «같은 포인터» 테스트).
  it('⭐복제는 오버레이 modifier로 36px 아래 · 오버레이는 누름을 통과시킨다', async () => {
    await mount();
    await act(async () => { (handlers as { start?: Handler }).start?.({ active: { id: 'a' } }); });
    expect(container.ownerDocument.querySelector('[data-overlay-root] > [data-drag-copy]')).not.toBeNull();
    const mods = overlay.modifiers as Array<(a: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => { y: number }>;
    expect(mods).toHaveLength(1);
    expect(mods[0]!({ transform: { x: 0, y: 10, scaleX: 1, scaleY: 1 } }).y).toBe(46);
    expect(overlay.className).toContain('pointer-events-none');
  });

  // 유나(4752 실 브라우저) — 판정이 그린 복제의 사각형(translated)을 읽으면 복제를 옮길 때 구역이 밀린다. 같은 포인터 = 같은 구역.
  it('⭐같은 포인터면 복제 사각형(translated)이 어디 있든 같은 구역 · 같은 요청', async () => {
    const { onMove } = await mount();
    const y = rowTop('F') + ROW / 2;
    for (const translatedTop of [y - 200, y + 36, y + 500]) {
      await act(async () => { pointerAt(y); handlers.move?.(dragEvent('a', 'F', y, 0, translatedTop)); });
      expect(zones()).toEqual(['F:into']);
    }
    await act(async () => { pointerAt(y); await handlers.end?.(dragEvent('a', 'F', y, 0, y + 36)); });
    expect(onMove).toHaveBeenCalledWith({ docId: 'a', parentId: 'F' });
  });

  // 페드루(4752 렌즈) — 끄는 중 aside가 자동 스크롤되면 dnd-kit delta에는 스크롤 이동량이 더해지지만 over.rect는 화면 좌표. 구역은 화면 포인터로만.
  // 옛 「끌기 시작 좌표 + delta」면 폴더 가운데가 스크롤만큼 아래로 읽혀 «뒤»/«안»이 틀어진다(RED).
  it('⭐끄는 중 스크롤돼도(delta에 스크롤 이동량 포함) 구역은 화면 포인터 기준 — 표시 = 요청', async () => {
    const { onMove, onReorder } = await mount();
    for (const scrolled of [0, 12, 36, 200]) {
      await move('a', 'F', rowTop('F') + ROW / 2, scrolled);
      expect(zones()).toEqual(['F:into']);
      await move('a', 'F', rowTop('F') + 4, scrolled);
      expect(zones()).toEqual(['F:before']);
      await move('a', 'F', rowTop('F') + ROW - 4, scrolled);
      expect(zones()).toEqual(['F:after']);
    }
    await drop('a', 'F', rowTop('F') + ROW / 2, 36);
    expect(onMove).toHaveBeenLastCalledWith({ docId: 'a', parentId: 'F' });
    await drop('a', 'F', rowTop('F') + 4, 36);
    expect(onReorder).toHaveBeenLastCalledWith({ docId: 'a', parentId: null, afterId: null });
  });

  // 까디르(4752 실물 하네스) — 자동 스크롤이 도는 중에 놓으면 놓는 순간 over.rect는 그 순간의 스크롤, 화면 표시는 직전 렌더 것. 놓을 때 다시 판정하면
  // 표시(«안으로»)와 저장(«뒤»)이 갈렸다. 놓을 때는 마지막으로 그린 표시를 그대로 쓴다(옛 코드: 다시 판정 → RED).
  it('⭐표시 뒤 over.rect만 바뀐(스크롤) 채 놓아도 저장 = 마지막으로 그린 표시', async () => {
    const { onMove, onReorder } = await mount();
    const y = rowTop('F') + ROW / 2;
    await move('a', 'F', y);
    expect(zones()).toEqual(['F:into']);
    // 놓는 순간: 행이 스크롤로 14px 올라가 같은 포인터가 행 아래 가장자리(«뒤»)로 읽히는 상태 — 그 사이 표시는 다시 그려지지 않았다.
    const shifted = { ...dragEvent('a', 'F', y), over: { id: 'F', rect: { ...dropBoxRect('F'), top: dropBoxRect('F').top - 14, bottom: dropBoxRect('F').bottom - 14 } } };
    await act(async () => { pointerAt(y); await handlers.end?.(shifted); });
    expect(onMove).toHaveBeenCalledWith({ docId: 'a', parentId: 'F' });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('⭐표시가 없었으면(그린 표시 없음) 놓아도 무동작', async () => {
    const { onMove, onReorder } = await mount();
    await act(async () => { pointerAt(rowTop('F') + ROW / 2); await handlers.end?.(dragEvent('a', 'F', rowTop('F') + ROW / 2)); });
    expect(onMove).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('pointerRowCollision — 겨눈 행 = 포인터가 있는 행(story #4366 · 유나 4752)', () => {
  const rects = new Map<string, { top: number; bottom: number; left: number; right: number; width: number; height: number }>([
    ['r1', { top: 0, bottom: 32, left: 0, right: 264, width: 264, height: 32 }],
    ['r2', { top: 36, bottom: 68, left: 0, right: 264, width: 264, height: 32 }],
  ]);
  const containers = [{ id: 'r1' }, { id: 'r2' }] as unknown as Parameters<typeof pointerRowCollision>[0]['droppableContainers'];
  const run = (y: number | null) => pointerRowCollision({
    active: {} as never, collisionRect: { top: 999, bottom: 1031, left: 0, right: 264, width: 264, height: 32 },
    droppableRects: rects as never, droppableContainers: containers, pointerCoordinates: y === null ? null : { x: 10, y },
  }).map((c) => c.id);

  it('⭐포인터가 든 행 · 틈이면 가까운 행 · 포인터 없으면 없음 — collisionRect(그린 복제)는 안 본다', () => {
    expect(run(10)).toEqual(['r1']);
    expect(run(50)).toEqual(['r2']);
    expect(run(33)).toEqual(['r1']);
    expect(run(35)).toEqual(['r2']);
    expect(run(null)).toEqual([]);
  });
});
