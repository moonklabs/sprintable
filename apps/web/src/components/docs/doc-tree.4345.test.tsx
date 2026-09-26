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
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING } from '@/lib/hover-reveal';
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
  const more = [...row.querySelectorAll<HTMLElement>(':scope > [role="button"]')].find((el) => !el.hasAttribute('data-drag-handle'))!;
  return { row, handle, more };
}

const tokens = (el: Element) => el.className.split(/\s+/);

describe('DocTree 행 «⋮» · 끌기 손잡이([SID:4345])', () => {
  it('«⋮» = HOVER_REVEAL(호버 없는 기기에선 늘 · 마우스는 행 호버 · 초점) + 초점 링 · 맨 opacity-0 없음 · 탭 순서 안', () => {
    const { row, more } = renderTree();
    expect(tokens(row)).toContain('group');
    for (const t of [...HOVER_REVEAL.split(' '), ...HOVER_REVEAL_FOCUS_RING.split(' ')]) expect(tokens(more), t).toContain(t);
    expect(tokens(more)).not.toContain('opacity-0');
    expect(tokens(more)).not.toContain('group-hover:opacity-100');
    expect(more.tabIndex).toBe(0);
  });

  it('상수가 비거나 바뀌어도 잡히게 — 글자로 핀(터치 늘 보임 · 마우스만 숨김 · 행 호버 · 행 안 초점 · 제 초점 · citron 링)', () => {
    const { more } = renderTree();
    expect(tokens(more)).toEqual(expect.arrayContaining([
      'opacity-100', 'pointer-fine:opacity-0', 'pointer-fine:group-hover:opacity-100',
      'pointer-fine:group-focus-within:opacity-100', 'pointer-fine:focus-within:opacity-100',
      'focus-visible:ring-3', 'focus-visible:ring-proof-citron',
      // PO · 유나 10:01Z — 누르는 자리 24×24(아이콘 그대로)
      'inline-flex', 'min-h-6', 'min-w-6', 'items-center', 'justify-center',
    ]));
  });

  it('행 버튼 오른쪽 여백 pr-8 — «⋮» 누르는 자리(right-2 + 24px)와 행 글자가 안 겹침', () => {
    const { row } = renderTree();
    const rowBtn = row.querySelector<HTMLElement>('[data-doc-id="d1"]')!;
    expect(tokens(rowBtn)).toContain('pr-8');
    expect(tokens(rowBtn)).not.toContain('pr-7');
  });

  it('«⋮»에 Enter → 메뉴가 열린다(키보드로 닿는 조작 — 지금처럼)', () => {
    const { more } = renderTree();
    const menu = more.nextElementSibling as HTMLElement;
    expect(tokens(menu)).toContain('hidden');
    act(() => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(tokens(more.nextElementSibling as HTMLElement)).toContain('block');
  });

  it('끌기 손잡이 = 마우스 전용: 탭 순서 밖(tabIndex -1) · 화면 읽기 밖(aria-hidden) · 호버로만 보임(터치엔 안 보임 — 눌러도 안 끌림)', () => {
    const { handle } = renderTree();
    expect(handle.tabIndex).toBe(-1);
    expect(handle.getAttribute('aria-hidden')).toBe('true');
    expect(handle.getAttribute('data-drag-handle')).toBe('mouse-only');
    // 터치에서 늘 보이게 하지 않는다 — 센서가 터치를 받지 않아서(#1988).
    expect(tokens(handle)).not.toContain('opacity-100');
    expect(tokens(handle)).toContain('group-hover:opacity-100');
  });

  it('행 안 탭 순서 = 행 버튼 → «⋮»(손잡이는 건너뜀)', () => {
    const { row } = renderTree();
    const focusables = [...row.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.closest('.hidden'));
    expect(focusables.map((el) => (el.hasAttribute('data-doc-id') ? 'row' : el.getAttribute('role') === 'button' ? 'more' : el.tagName))).toEqual(['row', 'more']);
  });
});
