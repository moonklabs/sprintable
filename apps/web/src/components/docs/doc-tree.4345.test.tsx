// @vitest-environment jsdom
//
// [SID:4345] 문서 트리 행의 «⋮»(메뉴)와 끌기 손잡이.
// - «⋮»: `opacity-0 group-hover:opacity-100`만이라 터치에선 늘 투명 · 키보드 초점이 가도 안 보였다 → HOVER_REVEAL + 초점 링.
// - 끌기 손잡이: 마우스 전용이다(센서가 터치를 안 받음 #1988 · 키보드 센서 없음) → 호버로만 보이게 두고, 탭 순서 · 화면 읽기에서 뺀다(PO 08:45Z).
// jsdom은 CSS를 안 입혀서 보임 여부는 클래스 모양으로 핀한다(실제 계산 값은 PR 본문 실브라우저 판 · 유나 실측).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HOVER_REVEAL } from '@/lib/hover-reveal';
import { DocTree } from './doc-tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const store = new Map<string, string>();
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
  vi.unstubAllGlobals();
});

function renderTree() {
  const doc = { id: 'd1', parent_id: null, title: '회의록', slug: 'd1', icon: null, sort_order: 0 };
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocTree docs={[doc]} selectedSlug={null} onSelect={() => {}} onDelete={async () => {}} projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
  const row = container.querySelector<HTMLButtonElement>('[data-doc-id="d1"]')!.parentElement!;
  const handle = row.querySelector<HTMLElement>('[data-drag-handle]')!;
  // story 4892 — «⋮» = ds IconButton(진짜 button) in the TreeRow's trailing slot; the slot (not the button) carries the hover-reveal classes.
  const trailing = row.querySelector<HTMLElement>('[data-slot="ds-tree-trailing"]')!;
  const more = trailing.querySelector<HTMLElement>('button')!;
  const handleSlot = row.querySelector<HTMLElement>('[data-slot="ds-tree-handle"]')!;
  return { row, handle, more, trailing, handleSlot };
}

const tokens = (el: Element) => el.className.split(/\s+/);

describe('DocTree 행 «⋮» · 끌기 손잡이([SID:4345])', () => {
  it('«⋮» = ds IconButton(진짜 단추) · 보임 규칙은 TreeRow 자리가 쥔다: HOVER_REVEAL(호버 없는 기기에선 늘 · 마우스는 행 호버 · 초점) · 맨 opacity-0 없음 · 탭 순서 안', () => {
    const { row, more, trailing } = renderTree();
    expect(tokens(row)).toContain('group');
    expect(more.tagName).toBe('BUTTON');
    expect(more.getAttribute('data-slot')).toBe('ds-icon-button');
    for (const t of HOVER_REVEAL.split(' ')) expect(tokens(trailing), t).toContain(t);
    expect(tokens(trailing)).not.toContain('opacity-0');
    expect(tokens(trailing)).not.toContain('group-hover:opacity-100');
    expect(more.tabIndex).toBe(0);
  });

  it('상수가 비거나 바뀌어도 잡히게 — 글자로 핀(터치 늘 보임 · 마우스만 숨김 · 행 호버 · 행 안 초점 · 제 초점) · 초점 링은 ds IconButton의 action 링', () => {
    const { more, trailing } = renderTree();
    expect(tokens(trailing)).toEqual(expect.arrayContaining([
      'opacity-100', 'mouse:opacity-0', 'mouse:group-hover:opacity-100',
      'mouse:group-focus-within:opacity-100', 'mouse:focus-within:opacity-100',
    ]));
    expect(tokens(more)).toEqual(expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-ds-action', 'touch:min-h-ds-touch']));
  });

  it('행 버튼 오른쪽 여백 pr-10(폰 touch:pr-14) — «⋮» 자리(right-2 + 24px · 폰은 44 누름 영역)와 행 글자가 안 겹침', () => {
    const { row } = renderTree();
    const rowBtn = row.querySelector<HTMLElement>('[data-doc-id="d1"]')!;
    expect(tokens(rowBtn)).toContain('pr-10');
    expect(tokens(rowBtn)).toContain('touch:pr-14');
    expect(tokens(rowBtn)).not.toContain('pr-8');
  });

  it('«⋮»에 Enter → 메뉴가 열린다(키보드로 닿는 조작 — 지금처럼)', () => {
    const { more } = renderTree();
    // #4349(#4724) — 메뉴는 열릴 때만 body로 포털한다(목록 overflow 밖). 그래서 «⋮» 옆 형제의 hidden/block이 아니라 닫힘 = 없음 · 열림 = body 직속으로 본다.
    const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]');
    expect(menu()).toBeNull();
    act(() => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(menu()).not.toBeNull();
    expect(menu()!.parentElement).toBe(document.body);
  });

  it('끌기 손잡이 = 마우스 전용: 탭 순서 밖(tabIndex -1) · 화면 읽기 밖(aria-hidden) · 호버로만 보임(터치엔 안 보임 — 눌러도 안 끌림)', () => {
    const { handle, handleSlot } = renderTree();
    expect(handle.tabIndex).toBe(-1);
    expect(handle.getAttribute('aria-hidden')).toBe('true');
    expect(handle.getAttribute('data-drag-handle')).toBe('mouse-only');
    // 터치에서 늘 보이게 하지 않는다 — 센서가 터치를 받지 않아서(#1988).
    expect(tokens(handleSlot)).not.toContain('opacity-100');
    expect(tokens(handleSlot)).toContain('opacity-0');
    expect(tokens(handleSlot)).toContain('pointer-fine:group-hover:opacity-100');
    expect(tokens(handleSlot)).toContain('pointer-coarse:hidden');
  });

  it('행 안 탭 순서 = 행 버튼 → «⋮»(손잡이는 건너뜀)', () => {
    const { row } = renderTree();
    const focusables = [...row.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.closest('.hidden'));
    expect(focusables.map((el) => (el.hasAttribute('data-doc-id') ? 'row' : el.getAttribute('data-slot') === 'ds-icon-button' ? 'more' : el.tagName))).toEqual(['row', 'more']);
  });
});
