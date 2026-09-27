// @vitest-environment jsdom
/**
 * story #4360 — 코드 블록 언어 고르개는 **자기 블록**의 언어를 바꾼다(AC1).
 *
 * 예전 `editor.commands.updateAttributes('codeBlock', …)`는 지금 선택 영역의 코드 블록을 바꿔, 커서가 블록 A에 있는 채 블록 B의 고르개로
 * 언어를 고르면 A가 바뀌었다. 이제 NodeView의 `updateAttributes`(자기 위치 · getPos) — 커서 A · B 고르개 → B만 바뀌고 A 무변.
 * 저장 왕복: 편집기가 내는 HTML에 바뀐 언어가 `data-language`로 실린다(다시 열어도 같은 언어).
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

// jsdom엔 배치(layout) API가 없다 — ProseMirror 선택 · 스크롤 계산이 부르는 것만 빈 사각형으로 채운다.
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

function languages(editor: Editor): Array<string | null> {
  const out: Array<string | null> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'codeBlock') out.push((node.attrs as { language?: string | null }).language ?? null);
  });
  return out;
}

describe('코드 블록 언어 고르개 — 자기 블록만', () => {
  it('커서가 블록 A에 있는 채 블록 B의 고르개로 언어를 고르면 B만 바뀌고 A는 그대로 · 나가는 HTML에도 실린다', async () => {
    const changes: string[] = [];
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider>
            <DocEditor value={TWO_BLOCKS} contentFormat="html" onChange={(v) => { changes.push(v); }} labels={LABELS} currentDocId="d1" projectId="p1" />
          </ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    await settle();
    const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    const editor = dom!.editor!;
    expect(languages(editor)).toEqual(['python', 'javascript']);

    await act(async () => { editor.commands.setTextSelection(3); });  // 커서 = 블록 A 안
    expect(editor.state.selection.$from.parent.attrs.language).toBe('python');

    const pickers = [...container.querySelectorAll<HTMLButtonElement>('div[contenteditable="false"].relative > button')];
    expect(pickers.length).toBe(2);
    await act(async () => { pickers[1]!.click(); });  // 블록 B의 고르개 열기
    const options = [...container.querySelectorAll<HTMLButtonElement>('[data-dropdown-panel="code-lang"] button')];
    // 지금 두 블록의 언어(JS · Python — 고르개 표기)가 아닌 것을 고른다.
    const target = options.find((b) => !['JS', 'JavaScript', 'Python'].includes((b.textContent ?? '').trim()));
    expect(target).toBeTruthy();
    await act(async () => { target!.click(); });

    const [a, b] = languages(editor);
    expect(a).toBe('python');  // 커서가 있던 블록은 그대로
    expect(b).not.toBe('javascript');  // 고르개가 붙은 블록이 바뀐다
    expect(b).not.toBeNull();
    expect(changes.at(-1)).toContain(`data-language="${b}"`);
    expect(changes.at(-1)).toContain('data-language="python"');
  });
});
