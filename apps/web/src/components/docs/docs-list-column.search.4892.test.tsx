// @vitest-environment jsdom
//
// story 4892 (UI-9 문서 목록 열) — the search field and the search results wear the ds parts: the field is a ds Input with a ds search glyph and a ds IconButton clear button, the results are ds ListRows
// that are themselves the buttons. The behaviour stays: typing calls onChange, clear calls onClear and the focus returns to the field, the match count / «없음» line lives above the results only (never under the field), a result
// shows its title, its slug (mono) and the matched words (<b> from the server → <mark>), only the open doc carries aria-current="page", loading / empty / cap lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TreeSearchInput } from './tree-search-input';
import { DocSearchResults } from './doc-search-results';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function setNative(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('TreeSearchInput — ds Input + ds Icon + ds IconButton (4892)', () => {
  async function mount(over: Partial<React.ComponentProps<typeof TreeSearchInput>> = {}) {
    const onChange = vi.fn(); const onClear = vi.fn();
    await act(async () => {
      root.render(<TreeSearchInput value="abc" onChange={onChange} onClear={onClear} isSearching={false} placeholder="검색" clearLabel="지우기" {...over} />);
    });
    return { onChange, onClear };
  }
  const input = () => container.querySelector('input') as HTMLInputElement;

  it('⭐the field is a ds Input and carries a decorative ds search glyph', async () => {
    await mount();
    expect(input().getAttribute('data-slot')).toBe('ds-input');
    expect(input().getAttribute('placeholder')).toBe('검색');
    const glyph = container.querySelector('svg[data-icon="search"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
  });

  it('typing is passed on through onChange', async () => {
    const { onChange } = await mount();
    await act(async () => { setNative(input(), 'abcd'); });
    expect(onChange).toHaveBeenCalledWith('abcd');
  });

  it('⭐while searching a ds IconButton clears: onClear is called and the focus returns to the field; not searching → no clear button', async () => {
    await mount({ isSearching: false });
    expect(container.querySelector('button[aria-label="지우기"]')).toBeNull();
    const { onClear } = await mount({ isSearching: true });
    const clear = container.querySelector('button[aria-label="지우기"]') as HTMLButtonElement;
    expect(clear.getAttribute('data-slot')).toBe('ds-icon-button');
    await act(async () => { clear.click(); });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input());
  });

  it('⭐the field draws NO count / «없음» line under it — those live above the results (one line on screen, not two) · while searching too', async () => {
    await mount({ isSearching: true });
    expect(container.querySelector('p')).toBeNull();
    expect(container.textContent).toBe('');
    await mount({ isSearching: false });
    expect(container.querySelector('p')).toBeNull();
  });
});

describe('DocSearchResults — ds ListRow (4892)', () => {
  const RESULTS = [
    { id: '1', title: '제목-1', slug: 'policy-a', icon: null, snippet: '앞 <b>맞은</b> 뒤' },
    { id: '2', title: '제목-2', slug: 'policy-b', icon: '📘', snippet: null },
  ];
  async function mount(over: Partial<React.ComponentProps<typeof DocSearchResults>> = {}) {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(<DocSearchResults results={RESULTS} loading={false} selectedSlug="policy-b" onSelect={onSelect} loadingLabel="불러오는 중" noResultsLabel="없음" resultCountLabel={(n) => `${n}건`} cap={50} {...over} />);
    });
    return onSelect;
  }
  const rows = () => [...container.querySelectorAll('[data-slot="ds-list-row"]')] as HTMLElement[];

  it('⭐every result is a ds ListRow that is the button itself, with title · slug (mono) · the matched words in <mark>', async () => {
    await mount();
    expect(rows().length).toBe(2);
    for (const r of rows()) expect(r.tagName).toBe('BUTTON');
    expect(rows()[0]!.textContent).toContain('제목-1');
    expect(rows()[0]!.textContent).toContain('policy-a');
    expect(rows()[0]!.querySelector('mark')?.textContent).toBe('맞은');
    expect(rows()[0]!.querySelector('span.font-mono')?.textContent).toBe('policy-a');   // the slug is shown in mono (story 2167 AC2)
    expect(rows()[1]!.textContent).toContain('📘');                                   // an emoji icon stays
    expect(rows()[1]!.querySelector('mark')).toBeNull();
  });

  it('choosing a result calls onSelect with its slug; only the open doc carries aria-current="page" and is drawn selected', async () => {
    const onSelect = await mount({ selectedSlug: 'policy-b' });
    await act(async () => { rows()[0]!.click(); });
    expect(onSelect).toHaveBeenCalledWith('policy-a');
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(rows().map((r) => r.className.split(/\s+/).includes('bg-ds-surface-high'))).toEqual([false, true]);
  });

  it('the count line, the loading line, the empty line and the cap line', async () => {
    await mount();
    expect(container.textContent).toContain('2건');
    await mount({ results: [], loading: true });
    expect(container.textContent).toContain('불러오는 중');
    await mount({ results: [], loading: false });
    expect(container.textContent).toContain('없음');
    await mount({ cap: 2, cappedLabel: '더 있어요' });
    expect(container.textContent).toContain('더 있어요');
    await mount({ cap: 50, cappedLabel: '더 있어요' });
    expect(container.textContent).not.toContain('더 있어요');
  });
});
