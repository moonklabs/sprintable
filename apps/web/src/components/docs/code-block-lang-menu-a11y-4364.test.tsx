// @vitest-environment jsdom
/**
 * story #4364 — 코드 블록 언어 목록의 키보드 · 화면 읽기 길(AC1 · AC2).
 *
 * 공용 훅(`usePortalMenuKeys`, 4349)을 쓴다: 트리거 `aria-haspopup="menu"` · `aria-expanded`(열림 따라) · `aria-controls` / 목록 `role="menu"`
 * · Esc = 닫고 **그 블록** 트리거로 초점. 지금 언어 항목은 색만이 아니라 `role="menuitemradio"` + `aria-checked`(하나만)로 드러난다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/ws-1/proj-b/docs/spec-1',
}));

const { DocEditor } = await import('./doc-editor');
const { ToastProvider } = await import('../ui/toast');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
for (const proto of [Range.prototype, Element.prototype] as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  proto.getBoundingClientRect = () => EMPTY_RECT;
}
if (!document.elementFromPoint) (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

const LABELS = new Proxy({}, { get: (_t, k) => String(k) }) as never;
const TWO_BLOCKS = '<pre data-language="python"><code class="language-python">print("A")</code></pre>'
  + '<pre data-language="javascript"><code class="language-javascript">console.log("B")</code></pre>';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function settle(ms = 200) {
  for (let i = 0; i < ms / 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function mountTwoBlocks(): Promise<{ editor: Editor; pickers: HTMLButtonElement[] }> {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <DocEditor value={TWO_BLOCKS} contentFormat="html" onChange={() => {}} labels={LABELS} currentDocId="d1" projectId="p1" />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await settle();
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  const pickers = [...container.querySelectorAll<HTMLButtonElement>('div[contenteditable="false"].relative > button')];
  expect(pickers.length).toBe(2);
  return { editor: dom!.editor!, pickers };
}

const list = () => container.querySelector<HTMLElement>('[data-dropdown-panel="code-lang"]');
const pressEscape = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
};

describe('코드 블록 언어 목록 — Esc · ARIA(story #4364)', () => {
  it('AC2 — 트리거는 메뉴를 연다고 알리고 aria-expanded가 열림을 따른다 · 목록은 role=menu', async () => {
    const { pickers } = await mountTwoBlocks();
    const b = pickers[1]!;
    expect(b.getAttribute('aria-haspopup')).toBe('menu');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBeNull();
    await act(async () => { b.click(); });
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(list()?.getAttribute('role')).toBe('menu');
    expect(b.getAttribute('aria-controls')).toBe(list()?.id);
    await act(async () => { b.click(); });
    expect(b.getAttribute('aria-expanded')).toBe('false');
  });

  it('AC1 — Esc로 목록이 닫히고 초점은 그 블록의 트리거로(다른 블록 아님)', async () => {
    const { pickers } = await mountTwoBlocks();
    await act(async () => { pickers[1]!.click(); });
    const focused = document.activeElement as HTMLElement;
    expect(list()?.contains(focused)).toBe(true);  // 열면 첫 항목에 초점(메뉴)
    await pressEscape(focused);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(pickers[1]);
    expect(pickers[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('4355 계약 위 — 열린 채 초점이 트리거에 있어도 Esc로 닫힌다(공용 훅의 트리거 Esc)', async () => {
    const { pickers } = await mountTwoBlocks();
    await act(async () => { pickers[1]!.click(); });
    pickers[1]!.focus();
    await pressEscape(pickers[1]!);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(pickers[1]);
    expect(pickers[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('AC2 — 지금 언어 항목만 aria-checked=true(색만이 아니라) · 고르면 따라간다', async () => {
    const { editor, pickers } = await mountTwoBlocks();
    await act(async () => { pickers[0]!.click(); });  // 블록 A(python)
    const checked = () => [...list()!.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')];
    expect(checked().length).toBe(1);
    expect((checked()[0]!.textContent ?? '').trim()).toBe('Python');
    const other = [...list()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((el) => el.getAttribute('aria-checked') === 'false')!;
    const otherLabel = (other.textContent ?? '').trim();
    await act(async () => { other.click(); });
    let a: string | null = null;
    editor.state.doc.descendants((node) => { if (node.type.name === 'codeBlock' && a === null) a = (node.attrs as { language?: string }).language ?? null; });
    expect(a).not.toBe('python');
    await act(async () => { pickers[0]!.click(); });
    expect(checked().length).toBe(1);
    expect((checked()[0]!.textContent ?? '').trim()).toBe(otherLabel);
  });

  it('AC3 — 삽입 메뉴(«+»)도 같은 길: aria-expanded · 열면 첫 항목 · Esc로 닫고 «+»로 초점', async () => {
    const { editor } = await mountTwoBlocks();
    await act(async () => { editor.commands.setTextSelection(3); });
    await settle(60);
    const label = koMessages.docs.attachInsertMenu;
    const plus = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) => b.getAttribute('aria-label') === label);
    expect(plus, '«+» 삽입 버튼이 그려진다').toBeTruthy();
    expect(plus!.getAttribute('aria-haspopup')).toBe('menu');
    expect(plus!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { plus!.click(); });
    expect(plus!.getAttribute('aria-expanded')).toBe('true');
    const menu = container.querySelector<HTMLElement>('[role="menu"]:not([data-dropdown-panel])');
    expect(menu).toBeTruthy();
    expect(menu!.contains(document.activeElement)).toBe(true);
    await pressEscape(document.activeElement!);
    expect(container.querySelector('[role="menu"]:not([data-dropdown-panel])')).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it('AC3 · 4355 계약 위 — «+» 메뉴도 초점이 «+»에 있을 때 Esc로 닫힌다', async () => {
    const { editor } = await mountTwoBlocks();
    await act(async () => { editor.commands.setTextSelection(3); });
    await settle(60);
    const plus = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) => b.getAttribute('aria-label') === koMessages.docs.attachInsertMenu)!;
    await act(async () => { plus.click(); });
    plus.focus();
    await pressEscape(plus);
    expect(container.querySelector('[role="menu"]:not([data-dropdown-panel])')).toBeNull();
    expect(plus.getAttribute('aria-expanded')).toBe('false');
  });
});
