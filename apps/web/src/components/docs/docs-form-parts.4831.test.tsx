// @vitest-environment jsdom
//
// story 4831 부품 교체(문서 쪽) — 문서 편집기 노드뷰의 URL 칸 · 페이지 임베드 칸 · 문서 트리 검색 칸이 바탕 Input이 되어도 동작이 그대로여야 한다.
// 지키는 것: ① 보이는 칸이 바탕 Input(data-slot=input) ② 편집기 노드뷰 칸의 키: 엔터는 적용하고 기본 동작(폼 제출 · 줄바꿈)을 막고, 에스케이프는 되돌리고,
// 방향키는 칸 안의 커서 이동 그대로(기본 동작을 막지 않는다 — 편집기로 새어 문서를 움직이지 않는다) ③ 페이지 임베드: 처음 열리면 칸에 초점, 실패하면 오류 줄과 함께 초점이 칸으로 돌아온다(ref가 부품을 지나 닿는다)
// ④ 트리 검색: 입력 · 지우기 단추가 칸에 초점을 돌려준다(ref).  되돌리면(날것 <input>으로) data-slot이 사라져 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  return { ...actual, NodeViewWrapper: ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div> };
});
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { EmbedView } from './extensions/embed-node';
import { PageEmbedView } from './extensions/page-embed-node';
import { TreeSearchInput } from './tree-search-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const docs = koMessages.docs as unknown as Record<string, string>;

function setNative(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe('EmbedView — URL 칸 (편집기 노드뷰)', () => {
  const props = (selected: boolean, update = vi.fn()) =>
    ({ node: { attrs: { url: 'https://example.com/a' } }, updateAttributes: update, selected }) as unknown as React.ComponentProps<typeof EmbedView>;

  it('선택됐을 때만 URL 칸이 보이고 바탕 Input이다', async () => {
    await act(async () => { root.render(wrap(<EmbedView {...props(false)} />)); });
    expect(container.querySelector('input')).toBeNull();
    await act(async () => { root.render(wrap(<EmbedView {...props(true)} />)); });
    const input = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${docs.embedUrlPlaceholder}"]`)!;
    expect(input.value).toBe('https://example.com/a');
  });

  it('엔터는 URL을 적용하고 기본 동작을 막는다 · 에스케이프는 되돌린다 · 방향키는 막지 않는다(칸 안에서 커서가 움직인다)', async () => {
    const update = vi.fn();
    await act(async () => { root.render(wrap(<EmbedView {...props(true, update)} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
    await act(async () => { setNative(input, '  https://example.com/b  '); });
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(input, 'Enter'); });
    expect(ev.defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledWith({ url: 'https://example.com/b' });
    await act(async () => { setNative(input, 'https://example.com/c'); });
    await act(async () => { key(input, 'Escape'); });
    expect(input.value).toBe('https://example.com/a');
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Backspace']) {
      let e!: KeyboardEvent;
      await act(async () => { e = key(input, k); });
      expect(e.defaultPrevented, k).toBe(false);
    }
  });

  it('한글 조합 중의 엔터는 적용하지 않고 기본 동작도 막지 않는다 · 조합 중의 에스케이프는 되돌리지 않는다 · 조합이 끝난 뒤의 엔터만 적용한다', async () => {
    const update = vi.fn();
    await act(async () => { root.render(wrap(<EmbedView {...props(true, update)} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
    await act(async () => { setNative(input, 'https://example.com/b한'); });
    let enter!: KeyboardEvent;
    await act(async () => { enter = key(input, 'Enter', { isComposing: true }); });
    expect(update).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    await act(async () => { key(input, 'Escape', { isComposing: true }); });
    expect(input.value).toBe('https://example.com/b한');
    // 옛 표지: 일부 브라우저는 조합 중 키를 keyCode 229로만 알린다
    await act(async () => { key(input, 'Enter', { keyCode: 229 }); });
    expect(update).not.toHaveBeenCalled();
    await act(async () => { enter = key(input, 'Enter'); });
    expect(enter.defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledWith({ url: 'https://example.com/b한' });
  });

  it('칸을 떠나면(blur) 적용된다', async () => {
    const update = vi.fn();
    await act(async () => { root.render(wrap(<EmbedView {...props(true, update)} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
    await act(async () => { setNative(input, 'https://example.com/d'); });
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(update).toHaveBeenCalledWith({ url: 'https://example.com/d' });
  });
});

describe('PageEmbedView — 문서 고르기 칸', () => {
  const props = (update = vi.fn()) =>
    ({ node: { attrs: { docId: null, title: null, icon: null, slug: null } }, updateAttributes: update, extension: { options: { currentDocId: 'doc-self' } } }) as unknown as React.ComponentProps<typeof PageEmbedView>;

  it('열리면 칸(바탕 Input)에 초점이 가 있고, 제출이 실패하면 오류 줄이 뜨고 초점이 칸으로 돌아온다', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await act(async () => { root.render(wrap(<PageEmbedView {...props()} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => { setNative(input, 'no-such-doc'); });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).not.toBe(input);
    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(String(fetchWithAuthMock.mock.calls[0]![0])).toContain('q=no-such-doc');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(docs.pageEmbedNotFound);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('엔터 키는 칸 안에서 기본 동작(폼 제출)을 막지 않고, 방향키도 막지 않는다', async () => {
    await act(async () => { root.render(wrap(<PageEmbedView {...props()} />)); });
    const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]')!;
    for (const k of ['Enter', 'ArrowLeft', 'ArrowRight', 'Tab']) {
      let e!: KeyboardEvent;
      await act(async () => { e = key(input, k); });
      expect(e.defaultPrevented, k).toBe(false);
    }
  });
});

describe('TreeSearchInput — 문서 트리 검색 칸', () => {
  function mount(isSearching: boolean, onChange = vi.fn(), onClear = vi.fn()) {
    return act(async () => {
      root.render(
        <TreeSearchInput value="abc" onChange={onChange} onClear={onClear} isSearching={isSearching} placeholder="검색" clearLabel="지우기" />,
      );
    });
  }

  it('바탕 Input이고 입력이 onChange로 전해진다', async () => {
    const onChange = vi.fn();
    await mount(false, onChange);
    const input = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][placeholder="검색"]')!;
    expect(input.value).toBe('abc');
    await act(async () => { setNative(input, 'abcd'); });
    expect(onChange).toHaveBeenCalledWith('abcd');
    expect(container.querySelector('button[aria-label="지우기"]')).toBeNull();
  });

  it('검색 중이면 지우기 단추가 보이고, 누르면 onClear가 불리고 초점이 칸으로 돌아온다', async () => {
    const onClear = vi.fn();
    await mount(true, vi.fn(), onClear);
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="지우기"]')!;
    await act(async () => { clear.click(); });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(container.querySelector('input[data-slot="ds-input"]'));
  });
});
