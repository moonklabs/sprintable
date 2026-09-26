// @vitest-environment jsdom
//
// story #4349 AC5(유나 실측) — 390/360 모바일 서랍에서 문서 트리 행 «⋮» 메뉴(82px)가 목록 아래 끝에서 세로 42px 잘려 «이름 변경»만 보였다
// (목록 `overflow-y-auto` · 서랍 `overflow-hidden` — 다른 파일(docs-client-layout)의 조상이라 부류 가드가 못 보는 자리).
// 이제 열릴 때만 body로 포털 → 행 오른쪽 끝에 맞춰 아래 · 모자라면 위로. 포털이라 DOM 순서상 «⋮» 뒤가 아니므로
// 열면 첫 항목으로 초점 · ↑↓ · Tab이 끝을 넘거나 Esc면 닫고 «⋮»로 돌려준다(Esc는 서랍 초점 트랩까지 안 간다).
// jsdom은 배치를 안 해서 행 · 메뉴 사각형을 값으로 둔다(뷰포트 768 · 메뉴 192×82).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DocTree } from './doc-tree';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let rowRect = { left: 8, right: 272, top: 100, bottom: 132 };

beforeEach(() => {
  rowRect = { left: 8, right: 272, top: 100, bottom: 132 };
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isMenu = this.getAttribute('data-dropdown-panel') === 'doc-tree-menu';
    const isRow = !isMenu && this.classList.contains('group') && this.querySelector(':scope > button[data-doc-id]') !== null;
    const r = isMenu ? { left: 80, right: 272, top: 0, bottom: 82, width: 192, height: 82 }
      : isRow ? { ...rowRect, width: rowRect.right - rowRect.left, height: rowRect.bottom - rowRect.top }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  container.className = 'overflow-y-auto';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DOC = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };

function mount(doc: typeof DOC = DOC, locale: 'ko' | 'en' = 'ko') {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DocTree docs={[doc]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} onRename={async () => {}} projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
}
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]');
// «⋮» = 행의 마지막 role=button div(첫째는 dnd-kit 끌기 손잡이 — attributes가 role=button · tabIndex 0을 준다).
const trigger = () => Array.from(container.querySelector<HTMLElement>('[data-doc-id="d1"]')!.parentElement!.querySelectorAll<HTMLElement>(':scope > div[role="button"]')).at(-1)!;
const items = () => Array.from(menu()!.querySelectorAll('button'));
const key = (el: Element, k: string, shiftKey = false) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })); });
const openByKey = () => { trigger().focus(); key(trigger(), 'Enter'); };

describe('DocTree 행 메뉴 — 목록 밖(body)에 · 모자라면 위로 · 키보드(story #4349 AC5)', () => {
  it('열면 body 직속 fixed · 목록(overflow 조상) 밖 · 행 오른쪽 끝에 맞춰 행 아래 4px', () => {
    mount();
    openByKey();
    expect(menu()!.parentElement).toBe(document.body);
    expect(container.contains(menu())).toBe(false);
    expect(menu()!.style.position).toBe('fixed');
    expect(menu()!.style.top).toBe('136px');
    expect(menu()!.style.left).toBe('80px'); // 272 − 192
    expect(menu()!.dataset.side).toBe('bottom');
  });

  it('목록 아래 끝(행 아래 남는 칸 < 82)이면 위로 뒤집는다 — 메뉴 전부가 보인다', () => {
    rowRect = { left: 8, right: 272, top: 700, bottom: 732 }; // 뷰포트 768 · 아래 24 · 위 688
    mount();
    openByKey();
    expect(menu()!.dataset.side).toBe('top');
    expect(menu()!.style.top).toBe('614px'); // 700 − 4 − 82
  });

  it('키보드로 열면 첫 항목에 초점 · ↓↑로 옮김(끝에서 돌아감)', () => {
    mount();
    openByKey();
    const [rename, del] = items();
    expect(rename.textContent).toBe((koMessages.docs as unknown as Record<string, string>).docTreeRename);
    expect(document.activeElement).toBe(rename);
    key(rename, 'ArrowDown');
    expect(document.activeElement).toBe(del);
    key(del, 'ArrowDown');
    expect(document.activeElement).toBe(rename);
    key(rename, 'ArrowUp');
    expect(document.activeElement).toBe(del);
  });

  it('Esc — 메뉴만 닫고 «⋮»로 초점 · 서랍 초점 트랩(document keydown)까지 안 간다', () => {
    const drawerTrap = vi.fn();
    document.addEventListener('keydown', drawerTrap);
    mount();
    openByKey();
    key(items()[0], 'Escape');
    document.removeEventListener('keydown', drawerTrap);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(drawerTrap.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  });

  it('Tab이 마지막 항목을 넘거나 Shift+Tab이 첫 항목을 넘으면 닫고 «⋮»로 · 가운데 Tab은 메뉴 안에 둔다', () => {
    mount();
    openByKey();
    key(items()[0], 'Tab');
    expect(menu()).not.toBeNull();
    const last = items()[items().length - 1];
    last.focus();
    key(last, 'Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    openByKey();
    key(items()[0], 'Tab', true);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('포털된 메뉴 안을 누르면 안 닫힘 · 바깥이면 닫힘', () => {
    mount();
    openByKey();
    act(() => { items()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(menu()).not.toBeNull();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(menu()).toBeNull();
  });

  // 까디르(4724) — ↑↓ 키보드 길을 얹어 «메뉴»가 됐으니 보조기기에도 메뉴로: 버튼 넷이 아니라 메뉴 항목 넷.
  it('메뉴 역할 — 트리거 aria-haspopup=menu · aria-expanded(닫힘 false · 열림 true) · aria-controls = 패널 id · 패널 role=menu · 항목 role=menuitem', () => {
    mount();
    const trig = trigger();
    expect(trig.getAttribute('aria-haspopup')).toBe('menu');
    expect(trig.getAttribute('aria-expanded')).toBe('false');
    expect(trig.hasAttribute('aria-controls')).toBe(false); // 닫혀 있으면 가리킬 패널이 없다
    openByKey();
    expect(trig.getAttribute('aria-expanded')).toBe('true');
    const panel = menu()!;
    expect(panel.getAttribute('role')).toBe('menu');
    expect(panel.id).not.toBe('');
    expect(trig.getAttribute('aria-controls')).toBe(panel.id);
    expect(document.getElementById(panel.id)).toBe(panel);
    expect(items().map((b) => b.getAttribute('role'))).toEqual(['menuitem', 'menuitem']);
    key(items()[0], 'Escape');
    expect(trig.getAttribute('aria-expanded')).toBe('false');
    expect(trig.hasAttribute('aria-controls')).toBe(false);
  });

  // 까디르 · 유나(4724) — 아이콘뿐이라 이름 없는 메뉴 버튼이었다 → docs.treeRowMenuAriaLabel(그 행 문서 제목 끼움 · 빈 제목 = newDocDefaultTitle).
  it('«⋮» 접근 가능한 이름 = 행 문서 제목을 끼운 문구 · 빈 제목이면 «제목 없음» · en도 같은 틀', () => {
    mount();
    expect(trigger().getAttribute('aria-label')).toBe('회의록 메뉴 열기');
    act(() => { root.unmount(); });
    root = createRoot(container);
    mount({ ...DOC, title: '   ' });
    expect(trigger().getAttribute('aria-label')).toBe('제목 없음 메뉴 열기');
    act(() => { root.unmount(); });
    root = createRoot(container);
    mount(DOC, 'en');
    expect(trigger().getAttribute('aria-label')).toBe('Open menu — 회의록');
  });

  // PO 23:16Z — 4718(#4345)과 겹친 자리. 이 PR의 키보드 메뉴 길 첫 발이 «⋮»이라, develop의 보임 규칙을 그대로 입었는지 못박는다:
  // 쉴 때 터치 불투명도 1(HOVER_REVEAL) · Tab으로 닿으면 보임 + 초점 링(HOVER_REVEAL · _FOCUS_RING) · 누르는 자리 24(HOVER_REVEAL_HIT).
  // 계산된 값(불투명도 · 링 · 24×24)은 jsdom이 못 재서 실브라우저 판으로 따로 쟀다(PR 댓글).
  it('«⋮»는 develop 보임 규칙 그대로 — 터치 쉴 때 보임 · 초점 때 보임 + 링 · 24 누르는 자리(맨 opacity-0 · group-hover만 0)', () => {
    mount();
    const cls = trigger().className.split(/\s+/);
    for (const token of `${HOVER_REVEAL} ${HOVER_REVEAL_FOCUS_RING} ${HOVER_REVEAL_HIT}`.split(' ')) expect(cls).toContain(token);
    expect(cls).not.toContain('opacity-0');
    expect(cls).not.toContain('group-hover:opacity-100');
    expect(trigger().tabIndex).toBe(0);
  });
});
