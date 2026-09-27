// @vitest-environment jsdom
//
// story #4348 — 끌기 말고도 옮길 길: «⋮» 메뉴의 위로 이동 · 아래로 이동 · 폴더로 이동…(고르개).
// - 꺼진 항목은 숨기지 않고 aria-disabled(초점 닿음) + 까닭 줄(aria-describedby). 까닭 줄은 하나만 — 정렬 보기가 이기고, 아니면 «더 보기로 더 불러오면».
// - 옮긴 뒤 스크린리더 알림(aria-live) + 초점을 옮긴 행으로(닫힌 폴더로 옮겼으면 그 폴더와 조상을 펼침).
// 저장은 호출부(onMenuMove) 몫이라 여기선 레이아웃처럼 낙관 반영 → 붙잡은 응답을 푸는 모의 부모로 돈다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DocTree, compareDocsForSort } from './doc-tree';
import { applyDocMove, planDocMove, type DocMoveAction, type DocMovePlaced, type MenuMovePlan, type MenuMoveResult } from './lib/doc-move';
import type { DocSortMode } from '@/app/(authenticated)/[ws]/[proj]/docs/docs-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TestDoc = { id: string; parent_id: string | null; title: string; slug: string; icon: null; sort_order: number; is_folder?: boolean };
const doc = (id: string, sort_order: number, extra: Partial<TestDoc> = {}): TestDoc => ({ id, parent_id: null, title: id, slug: id, icon: null, sort_order, ...extra });

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

// 모의 부모: 레이아웃(handleMenuMove)처럼 누르면 곧바로 낙관 반영 · 응답은 테스트가 풀 때까지 붙잡는다.
// settle(ok, placed?) — placed를 안 주면 «서버 형제 = 불러온 형제»인 응답 흉내(자리 = 계획 자리 · 수 = 계획 형제 수) · null이면 서버 자리 모름.
const calls: Array<{ docId: string; action: DocMoveAction; settle: (ok: boolean, placed?: DocMovePlaced | null) => Promise<void> }> = [];
const harness: { setDocs: (next: TestDoc[]) => void } = { setDocs: () => {} };

function Harness({ initial, sortMode, hasMore, withMove }: { initial: TestDoc[]; sortMode: DocSortMode; hasMore: boolean; withMove: boolean }) {
  const [docs, setDocs] = useState(initial);
  useEffect(() => { harness.setDocs = setDocs; }, []);
  const onMenuMove = (docId: string, action: DocMoveAction) => new Promise<MenuMoveResult>((resolve) => {
    let plan: MenuMovePlan | null = null;
    setDocs((prev) => {
      plan = planDocMove(prev, docId, action);
      return plan.ok ? applyDocMove(prev, plan) : prev;
    });
    calls.push({ docId, action, settle: async (ok, placed) => {
      const p = plan!;
      const guess = p.ok ? { position: p.index + 1, total: p.orderedIds.length } : null;
      await act(async () => { resolve(ok ? { plan: p, placed: placed === undefined ? guess : placed } : null); await Promise.resolve(); });
    } });
  });
  return (
    <DocTree docs={docs} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} onRename={async () => {}} projectId="p1" sortMode={sortMode}
      onMenuMove={withMove ? onMenuMove : undefined} hasMore={hasMore} />
  );
}

function mount(initial: TestDoc[], { sortMode = 'manual', hasMore = false, locale = 'ko', withMove = true }: { sortMode?: DocSortMode; hasMore?: boolean; locale?: 'ko' | 'en'; withMove?: boolean } = {}) {
  calls.length = 0;
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <Harness initial={initial} sortMode={sortMode} hasMore={hasMore} withMove={withMove} />
      </NextIntlClientProvider>,
    );
  });
}

const row = (id: string) => container.querySelector<HTMLElement>(`button[data-doc-id="${id}"]`);
const rowOrder = () => Array.from(container.querySelectorAll<HTMLElement>('button[data-doc-id]')).map((b) => b.dataset.docId);
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]');
const trigger = (id: string) => Array.from(row(id)!.parentElement!.querySelectorAll<HTMLElement>(':scope > div[role="button"]')).at(-1)!;
const open = (id: string) => act(() => { trigger(id).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const moveItem = (kind: 'up' | 'down' | 'into') => menu()!.querySelector<HTMLElement>(`[data-move="${kind}"]`)!;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const notes = () => Array.from(menu()!.querySelectorAll('p')).filter((p) => p.id);
const live = () => container.querySelector<HTMLElement>('[data-doc-move-live]')!;
const describedText = (el: Element) => {
  const id = el.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

const KO = koMessages.docs;
const THREE = [doc('a', 10), doc('b', 20), doc('c', 30)];

describe('«⋮» 옮기기 항목 · 꺼짐 까닭(story #4348)', () => {
  it('수동 보기: 위로 · 아래로 · 폴더로 이동… — 맨 위 문서는 위로만 aria-disabled · 까닭 줄 0', () => {
    mount([...THREE, doc('f', 40, { is_folder: true })]);
    open('a');
    expect([moveItem('up'), moveItem('down'), moveItem('into')].map((b) => [b.textContent, b.getAttribute('role'), b.getAttribute('aria-disabled')])).toEqual([
      [KO.docTreeMoveUp, 'menuitem', 'true'],
      [KO.docTreeMoveDown, 'menuitem', null],
      [KO.docTreeMoveInto, 'menuitem', null],
    ]);
    expect(moveItem('up').hasAttribute('aria-describedby')).toBe(false);
    expect(notes()).toHaveLength(0);
  });

  it('꺼진 항목을 눌러도 옮기지 않고 메뉴는 열린 채', () => {
    mount(THREE);
    open('a');
    click(moveItem('up'));
    expect(calls).toHaveLength(0);
    expect(menu()).not.toBeNull();
  });

  it('이름순 보기: 위로 · 아래로 둘 다 꺼지고 까닭 = 정렬 문구 하나(더 불러올 것이 있어도 정렬 까닭만)', () => {
    mount(THREE, { sortMode: 'title', hasMore: true });
    open('c'); // 받은 형제 중 마지막 — 더 보기 까닭과 겹치는 자리
    expect(moveItem('up').getAttribute('aria-disabled')).toBe('true');
    expect(moveItem('down').getAttribute('aria-disabled')).toBe('true');
    expect(describedText(moveItem('up'))).toBe(KO.moveSortModeActiveError);
    expect(describedText(moveItem('down'))).toBe(KO.moveSortModeActiveError);
    expect(notes().map((p) => p.textContent)).toEqual([KO.moveSortModeActiveError]);
    // 폴더로 이동은 정렬과 무관(옮길 폴더가 없으면 항목 자체가 없음)
    expect(menu()!.querySelector('[data-move="into"]')).toBeNull();
  });

  it('수동 · 더 불러올 것 있음 · 받은 마지막 문서: 아래로만 꺼지고 까닭 = «더 보기» 문구(ko · en 글자 그대로)', () => {
    mount(THREE, { hasMore: true });
    open('c');
    expect(moveItem('down').getAttribute('aria-disabled')).toBe('true');
    expect(describedText(moveItem('down'))).toBe('목록 맨 아래 「더 보기」로 문서를 더 불러오면 아래로 이동할 수 있어요.');
    expect(moveItem('up').getAttribute('aria-disabled')).toBeNull();
    expect(moveItem('up').hasAttribute('aria-describedby')).toBe(false);
    expect(notes()).toHaveLength(1);
    click(moveItem('down'));
    expect(calls).toHaveLength(0);

    act(() => { root.unmount(); });
    root = createRoot(container);
    mount(THREE, { hasMore: true, locale: 'en' });
    open('c');
    expect(describedText(moveItem('down'))).toBe('To move this down, first use “Load more” at the bottom of the list.');
  });

  it('더 불러올 것이 있어도 마지막이 아니면 아래로 켜짐 · 까닭 줄 0', () => {
    mount(THREE, { hasMore: true });
    open('b');
    expect(moveItem('down').getAttribute('aria-disabled')).toBeNull();
    expect(moveItem('down').hasAttribute('aria-describedby')).toBe(false);
    expect(notes()).toHaveLength(0);
  });

  it('onMenuMove를 안 넘기는 호출처는 옮기기 항목 0(예전 메뉴 그대로)', () => {
    mount(THREE, { withMove: false });
    open('a');
    expect(menu()!.querySelectorAll('[data-move]')).toHaveLength(0);
    expect(container.querySelector('[data-doc-move-live]')).not.toBeNull();
  });
});

describe('옮긴 뒤 알림 · 초점(story #4348)', () => {
  it('아래로: 누르면 메뉴 닫힘 · 곧바로 새 자리 · 응답 뒤 «N개 중 M번째» 알림 · 초점 = 옮긴 행', async () => {
    mount(THREE);
    open('a');
    click(moveItem('down'));
    expect(menu()).toBeNull();
    expect(calls.map((c) => [c.docId, c.action])).toEqual([['a', { kind: 'down' }]]);
    expect(rowOrder()).toEqual(['b', 'a', 'c']);
    expect(document.activeElement).toBe(row('a'));
    expect(live().textContent).toBe('');
    await calls[0].settle(true);
    expect(live().textContent).toBe('a, 3개 중 2번째로 이동했어요.');
    expect(live().getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(row('a'));
  });

  it('폴더로 이동…: 고르개(제목 = 메뉴 이름 · 첫 항목 초점) → 폴더 고름 → «F 폴더로» 알림', async () => {
    mount([...THREE, doc('f', 40, { is_folder: true, title: '기획' })]);
    open('b');
    click(moveItem('into'));
    const title = menu()!.querySelector('p')!;
    expect(title.textContent).toBe(KO.docTreeMovePickerTitle);
    expect(menu()!.getAttribute('aria-labelledby')).toBe(title.id);
    const targets = Array.from(menu()!.querySelectorAll<HTMLElement>('[data-move-target]'));
    // 맨 위 문서라 «맨 위 단계»는 지금 자리 — 남되 누를 수 없음(aria-current · «현재 위치» 표식은 aria-hidden)
    expect(targets.map((b) => [b.textContent, b.getAttribute('role'), b.getAttribute('aria-disabled'), b.getAttribute('aria-current')])).toEqual([
      [`${KO.docTreeMoveTopLevel}${KO.docTreeMoveCurrentLocation}`, 'menuitem', 'true', 'location'],
      ['기획', 'menuitem', null, null],
    ]);
    expect(targets[0].querySelector('[data-current-location]')!.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(targets[1]); // 첫 누를 수 있는 줄
    click(targets[1]);
    expect(calls.map((c) => c.action)).toEqual([{ kind: 'into', parentId: 'f' }]);
    await calls[0].settle(true);
    expect(live().textContent).toBe('b, 기획 폴더로 이동했어요.');
    expect(document.activeElement).toBe(row('b'));
  });

  it('폴더 안 문서: 고르개 첫 항목 = «맨 위 단계» → 맨 위로 알림', async () => {
    mount([doc('f', 10, { is_folder: true, title: '기획' }), doc('x', 10, { parent_id: 'f' })]);
    open('x');
    click(moveItem('into'));
    const targets = Array.from(menu()!.querySelectorAll<HTMLElement>('[data-move-target]'));
    expect(targets.map((b) => [b.textContent, b.getAttribute('aria-current')])).toEqual([[KO.docTreeMoveTopLevel, null], [`기획${KO.docTreeMoveCurrentLocation}`, 'location']]);
    expect(document.activeElement).toBe(targets[0]);
    click(targets[0]);
    await calls[0].settle(true);
    expect(live().textContent).toBe('x, 맨 위 단계로 이동했어요.');
    expect(rowOrder()).toEqual(['f', 'x']);
  });

  it('접힌 폴더(조상까지 접힘)로 옮기면 그 폴더와 조상을 펼치고 옮긴 행에 초점', async () => {
    store.set('docs:tree:expanded:p1', JSON.stringify(['outer', 'inner']));
    mount([doc('a', 10), doc('outer', 20, { is_folder: true }), doc('inner', 10, { parent_id: 'outer', is_folder: true })]);
    expect(row('inner')).toBeNull(); // 바깥 폴더가 접혀 안 보임
    open('a');
    click(moveItem('into'));
    const inner = menu()!.querySelector<HTMLElement>('[data-move-target="inner"]')!;
    click(inner);
    expect(JSON.parse(store.get('docs:tree:expanded:p1')!)).toEqual([]);
    expect(row('inner')).not.toBeNull();
    expect(document.activeElement).toBe(row('a'));
    await calls[0].settle(true);
    expect(document.activeElement).toBe(row('a'));
  });

  it('저장 실패(null): 알림 0 · 초점이 떨어졌으면(body) 그 행으로 되찾음', async () => {
    mount(THREE);
    open('a');
    click(moveItem('down'));
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await calls[0].settle(false);
    expect(live().textContent).toBe('');
    expect(document.activeElement).toBe(row('a'));
  });

  it('응답 전에 사용자가 초점을 옮겼으면 뺏지 않음', async () => {
    mount(THREE);
    open('a');
    click(moveItem('down'));
    act(() => { row('c')!.focus(); });
    await calls[0].settle(true);
    expect(document.activeElement).toBe(row('c'));
  });

  it('저장이 끝났는데 그 행이 트리에 없으면 초점 대기를 놓는다 — 나중에 행이 다시 나타나도 초점을 끌어가지 않음', async () => {
    mount(THREE);
    open('a');
    click(moveItem('down'));
    act(() => { harness.setDocs([doc('b', 20), doc('c', 30)]); }); // 예: 필터로 사라짐
    (document.activeElement as HTMLElement).blur();
    await calls[0].settle(false);
    expect(document.activeElement).toBe(document.body);
    act(() => { harness.setDocs(THREE); });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('수동 보기 순서 = 서버 순서 `(sort_order, id)`(story #4348)', () => {
  it('같은 번호면 id 순 — 화면에 보이는 옆 문서와 «⋮» 위로 · 아래로가 보는 옆 문서가 같다', () => {
    const tied = [doc('z', 0), doc('m', 0), doc('a', 0)];
    expect([...tied].sort((x, y) => compareDocsForSort(x as never, y as never, 'manual')).map((d) => d.id)).toEqual(['a', 'm', 'z']);
    mount(tied);
    expect(rowOrder()).toEqual(['a', 'm', 'z']);
    open('m');
    click(moveItem('up'));
    expect(rowOrder()).toEqual(['m', 'a', 'z']);
  });
});

describe('고르개 — 트리 깊이 우선 · 들여쓰기 · 지금 자리(유나 #4730 확정 01:43Z)', () => {
  const NESTED = [
    doc('x', 10, { title: '문서' }),
    doc('plan', 50, { is_folder: true, title: '기획 폴더' }),
    doc('sub', 1, { parent_id: 'plan', is_folder: true, title: '하위 폴더' }),
    doc('ops', 60, { is_folder: true, title: '운영' }),
    doc('sub2', 1, { parent_id: 'ops', is_folder: true, title: '하위 폴더' }),
  ];
  const pickerRows = () => Array.from(menu()!.querySelectorAll<HTMLElement>('[data-move-target]'));

  it('하위 폴더(sort 1)가 부모(sort 50) 뒤 · 같은 이름은 다른 부모 밑 깊이로 · 들여쓰기 12 + 깊이×12px · 긴 이름 title', () => {
    mount(NESTED);
    open('x');
    click(moveItem('into'));
    expect(pickerRows().map((b) => [b.dataset.moveTarget, b.dataset.depth, b.style.paddingLeft, b.getAttribute('title')])).toEqual([
      ['', '0', '12px', KO.docTreeMoveTopLevel],
      ['plan', '1', '24px', '기획 폴더'],
      ['sub', '2', '36px', '하위 폴더'],
      ['ops', '1', '24px', '운영'],
      ['sub2', '2', '36px', '하위 폴더'],
    ]);
    expect(pickerRows()[1].querySelector('span')!.className).toContain('truncate');
  });

  it('이름순 보기면 고르개 형제도 이름순(트리 보기와 같은 비교)', () => {
    mount([doc('x', 10), doc('z', 1, { is_folder: true, title: '나 폴더' }), doc('y', 2, { is_folder: true, title: '가 폴더' })], { sortMode: 'title' });
    open('x');
    click(moveItem('into'));
    expect(pickerRows().map((b) => b.dataset.moveTarget)).toEqual(['', 'y', 'z']);
  });

  it('지금 자리 줄: 눌러도 옮기지 않고 메뉴는 열린 채 · ↑↓는 그 줄에도 닿음', () => {
    // x를 하위 폴더(plan 밑) 안에 두고 연다 — 폴더 펼침이 기본
    mount(NESTED.map((d) => (d.id === 'x' ? { ...d, parent_id: 'sub' } : d)));
    open('x');
    click(moveItem('into'));
    const current = pickerRows().find((b) => b.getAttribute('aria-current') === 'location')!;
    expect(current.dataset.moveTarget).toBe('sub');
    click(current);
    expect(calls).toHaveLength(0);
    expect(menu()).not.toBeNull();
    // 첫 초점 = 맨 위 단계(누를 수 있음) → ↓ 두 번이면 지금 자리(sub)에 닿는다
    expect(document.activeElement).toBe(pickerRows()[0]);
    act(() => { menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(current);
  });

  it('옮길 폴더가 지금 자리뿐이면 «폴더로 이동…» 항목이 없다', () => {
    mount(THREE);
    open('a');
    expect(menu()!.querySelector('[data-move="into"]')).toBeNull();
  });
});

describe('위치 알림 N — 서버 형제 수(까디르 #4730 P3 · 유나 확정 문구)', () => {
  it('서버가 형제 37이라 하면 «37개 중» · 불러온 수(3)가 아님', async () => {
    mount(THREE, { hasMore: false });
    open('a');
    click(moveItem('down'));
    await calls[0].settle(true, { position: 2, total: 37 });
    expect(live().textContent).toBe('a, 37개 중 2번째로 이동했어요.');
  });

  it('서버 자리를 모르면 «M번째»만(docTreeMovedPositionOnly)', async () => {
    mount(THREE);
    open('a');
    click(moveItem('down'));
    await calls[0].settle(true, null);
    expect(live().textContent).toBe('a, 2번째로 이동했어요.');
  });
});

describe('옮기기 항목 = 디자인 Button(ghost) · 같은 메뉴 줄 모양(DS 게이트 A)', () => {
  it('위로 · 아래로 · 폴더로 · 고르개 줄: 채움 없음(ghost) · 왼쪽 정렬 · 보통 굵기 · 높이 자동 · 테두리 0', () => {
    mount([...THREE, doc('f', 40, { is_folder: true, title: '기획' })]);
    open('b');
    const main = [moveItem('up'), moveItem('down'), moveItem('into')];
    click(moveItem('into'));
    const rows = Array.from(menu()!.querySelectorAll<HTMLElement>('[data-move-target]'));
    for (const el of [...main, ...rows]) {
      const cls = el.className.split(/\s+/);
      expect(el.tagName).toBe('BUTTON');
      expect(cls).toEqual(expect.arrayContaining(['justify-start', 'font-normal', 'h-auto', 'min-h-0', 'border-0', 'text-left']));
      expect(cls).not.toContain('bg-primary');
      expect(cls).not.toContain('justify-center');
    }
  });
});

