// @vitest-environment jsdom
/**
 * story #4365 — 토글 블록 여닫기(AC).
 *
 * 요약 NodeView가 자기 토글 블록을 한 단계 위(`node($pos.depth - 1)`)에서 찾아, 최상위 토글이면 `doc`이 나와 클릭이 곧바로 return하고
 * 열림 표시도 늘 «닫힘»이었다. 실 편집기로 확인한다: 최상위 · 중첩(토글 안의 토글) 둘 다 클릭하면 열리고 다시 닫히며, 표시(aria-label ·
 * DOM `data-open`)와 저장 HTML(`data-open`)이 같이 따라간다. 처음부터 열린 토글은 «접기»로 뜬다.
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
const { resolveToggleBlockOfSummary } = await import('./extensions/toggle-block');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom엔 배치(layout) API가 없다 — ProseMirror 선택 · 스크롤 계산이 부르는 것만 빈 사각형으로 채운다.
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
for (const proto of [Range.prototype, Element.prototype] as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown }[]) {
  proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  proto.getBoundingClientRect = () => EMPTY_RECT;
}
if (!document.elementFromPoint) (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

const LABELS = new Proxy({}, { get: (_t, k) => String(k) }) as never;
const EXPAND = koMessages.docs.toggleExpand;
const COLLAPSE = koMessages.docs.toggleCollapse;

const toggle = (open: boolean, summary: string, inner: string) =>
  `<div data-type="toggleBlock" data-open="${open}"><div data-type="toggleSummary">${summary}</div><div data-type="toggleContent">${inner}</div></div>`;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function settle(ms = 200) {
  for (let i = 0; i < ms / 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function mount(html: string): Promise<{ editor: Editor; changes: string[] }> {
  const changes: string[] = [];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <DocEditor value={html} contentFormat="html" onChange={(v) => { changes.push(v); }} labels={LABELS} currentDocId="d1" projectId="p1" />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await settle();
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  return { editor: dom!.editor!, changes };
}

function openStates(editor: Editor): boolean[] {
  const out: boolean[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'toggleBlock') out.push(Boolean(node.attrs.open));
  });
  return out;
}

const toggleButtons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-type="toggleSummary"] button, .ProseMirror button[aria-label]')]
  .filter((b) => b.getAttribute('aria-label') === EXPAND || b.getAttribute('aria-label') === COLLAPSE);

describe('토글 블록 여닫기(story #4365)', () => {
  it('최상위 토글: 클릭하면 열리고(표시 · DOM · 저장 HTML) 다시 누르면 닫힌다', async () => {
    const { editor, changes } = await mount(toggle(false, '제목', '<p>본문</p>'));
    expect(openStates(editor)).toEqual([false]);
    const [button] = toggleButtons();
    expect(button?.getAttribute('aria-label')).toBe(EXPAND);

    await act(async () => { button!.click(); });
    await settle(60);
    expect(openStates(editor)).toEqual([true]);
    expect(toggleButtons()[0]?.getAttribute('aria-label')).toBe(COLLAPSE);
    expect(container.querySelector('.ProseMirror [data-type="toggleBlock"]')?.getAttribute('data-open')).toBe('true');
    expect(changes.at(-1)).toContain('data-open="true"');

    await act(async () => { toggleButtons()[0]!.click(); });
    await settle(60);
    expect(openStates(editor)).toEqual([false]);
    expect(toggleButtons()[0]?.getAttribute('aria-label')).toBe(EXPAND);
  });

  it('처음부터 열린 토글은 «접기»로 뜬다(표시가 늘 «닫힘»이던 자리)', async () => {
    await mount(toggle(true, '제목', '<p>본문</p>'));
    expect(toggleButtons()[0]?.getAttribute('aria-label')).toBe(COLLAPSE);
  });

  it('중첩 토글: 안쪽 토글의 버튼은 안쪽만 바꾼다(바깥 무변)', async () => {
    const { editor } = await mount(toggle(true, '바깥', toggle(false, '안쪽', '<p>본문</p>')));
    expect(openStates(editor)).toEqual([true, false]);
    const buttons = toggleButtons();
    expect(buttons.length).toBe(2);
    await act(async () => { buttons[1]!.click(); });
    await settle(60);
    expect(openStates(editor)).toEqual([true, true]);
  });

  it('도우미: 요약 바로 앞 위치 → 그 요약을 담은 토글 블록(최상위면 doc이 아니라 토글)', async () => {
    const { editor } = await mount(toggle(false, '제목', '<p>본문</p>'));
    let summaryPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'toggleSummary' && summaryPos < 0) summaryPos = pos;
    });
    const found = resolveToggleBlockOfSummary(editor.state.doc, summaryPos);
    expect(found?.node.type.name).toBe('toggleBlock');
    expect(found?.pos).toBe(0);
    expect(resolveToggleBlockOfSummary(editor.state.doc, 0)).toBeNull();  // 문서 최상위 자리 = 토글 안이 아님
  });
});
