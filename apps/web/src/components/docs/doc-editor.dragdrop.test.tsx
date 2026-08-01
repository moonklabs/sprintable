// @vitest-environment jsdom
//
// story #2372(2026-08-01) — #2757과 같은 병(같은 규격의 두 번째 적용 사례). doc-editor.tsx엔
// 지금까지 테스트가 아예 없었다 — 실제 Tiptap/ProseMirror는 jsdom이 못 주는 DOM 측정 API들
// (getClientRects 등)을 요구해 전체 마운트가 안 된다(이 파일의 관심사와 무관한 jsdom 갭).
// 그래서 useEditor/EditorContent/BubbleMenu만 얇게 스텁하고(editor=null — 실제로 tiptap이
// 아직 준비 안 된 상태와 같은, 컴포넌트가 이미 처리하는 정상 분기) 이 파일의 진짜 관심사인
// 주변 JSX 구조(스크롤 컨테이너·DnD 오버레이의 위치)만 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: () => <div data-testid="editor-content-stub" />,
}));
vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: () => null,
}));

const { DocEditor } = await import('./doc-editor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const LABELS = {
  contentFormat: 'Format', markdown: 'Markdown', preview: 'Preview', save: 'Save', toolbar: 'Toolbar',
  placeholder: 'Write something…', h1: 'H1', h2: 'H2', bold: 'Bold', italic: 'Italic', bullet: 'Bullet',
  quote: 'Quote', code: 'Code', link: 'Link', autosave: 'Autosave', undo: 'Undo', redo: 'Redo',
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function scrollContainer(): HTMLElement {
  const el = container.querySelector('.tiptap-editor-wrapper');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function fireDragEnterWithFiles(el: Element) {
  const ev = new Event('dragenter', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'] } });
  el.dispatchEvent(ev);
}

describe('DocEditor — story #2372: DnD 드롭 오버레이가 세로 스크롤에 클리핑되지 않는다', () => {
  it('shows the drop overlay on dragenter with Files, positioned outside the scrolling container', async () => {
    await act(async () => {
      root.render(wrap(
        <DocEditor value="hello" contentFormat="markdown" onChange={() => {}} labels={LABELS} />,
      ));
    });

    expect(container.querySelector('[data-testid="doc-editor-drop-overlay"]')).toBeNull();

    await act(async () => { fireDragEnterWithFiles(scrollContainer()); });

    const overlay = container.querySelector('[data-testid="doc-editor-drop-overlay"]');
    expect(overlay).not.toBeNull();

    // story #2369 회귀 테스트(flow-multi-lane-canvas.test.tsx)와 같은 성질 — 오버레이의
    // 조상 중 overflow-y-auto(세로로 스크롤하는 요소)가 없어야 한다. `.tiptap-editor-wrapper`
    // 자신이 그 스크롤 컨테이너이므로, 오버레이가 «그 밖»(형제)에 있어야 이 성질이 선다.
    let node = overlay!.parentElement;
    let hasScrollingAncestor = false;
    while (node) {
      if (node.className.includes('overflow-y-auto')) hasScrollingAncestor = true;
      node = node.parentElement;
    }
    expect(hasScrollingAncestor).toBe(false);

    // 그리고 오버레이는 스크롤 컨테이너의 «형제»(같은 non-clipping relative wrapper의 자식)
    // 여야 한다 — 스크롤 컨테이너 자신의 자손이면 안 된다.
    expect(scrollContainer().contains(overlay)).toBe(false);
  });

  it('drag handlers stay on the scrolling container (AC5 — drop itself keeps working)', async () => {
    await act(async () => {
      root.render(wrap(
        <DocEditor value="hello" contentFormat="markdown" onChange={() => {}} labels={LABELS} />,
      ));
    });
    // React attaches synthetic handlers at the root, but the element the props were given to
    // is still this one — dispatching straight at it must still flip isDragging (proves the
    // handlers moved with the element, not silently dropped during the restructure).
    await act(async () => { fireDragEnterWithFiles(scrollContainer()); });
    expect(container.querySelector('[data-testid="doc-editor-drop-overlay"]')).not.toBeNull();
  });
});
