// @vitest-environment jsdom
//
// story #2372(2026-08-01) — #2757과 같은 병(같은 규격의 두 번째 적용 사례). doc-editor.tsx엔
// 지금까지 테스트가 아예 없었다 — 실제 Tiptap/ProseMirror는 jsdom이 못 주는 DOM 측정 API들
// (getClientRects 등)을 요구해 전체 마운트가 안 된다(이 파일의 관심사와 무관한 jsdom 갭).
// 그래서 useEditor/EditorContent/BubbleMenu만 얇게 스텁하고(editor=null — 실제로 tiptap이
// 아직 준비 안 된 상태와 같은, 컴포넌트가 이미 처리하는 정상 분기) 이 파일의 진짜 관심사인
// 주변 JSX 구조(스크롤 컨테이너·DnD 오버레이의 위치)만 잰다.
//
// ⛔이 테스트가 «못 잡는» 것을 스스로 말해 둔다(올리베이라군 리뷰, 2026-08-01) — jsdom엔
// 레이아웃 엔진이 없어 scrollHeight/clientHeight가 항상 같은 값(뜻이 없는 수)을 낸다. 그래서
// 이 파일은 «구조»(오버레이가 클리핑 밖인가)만 재고, «레이아웃»(min-h-0 누락처럼 편집기 내부
// 스크롤이 실제로 죽는가)은 원리적으로 못 잰다 — 이 신규 테스트 110줄이 전부 초록이었을
// 때도 그 회귀(바깥 flex-1이 overflow:visible이라 min-height:auto가 콘텐츠 높이만큼 살아남아
// 내부 스크롤이 죽고 편집기 셸이 넘치는 것)를 못 잡았다. 후자는 실제 브라우저에서만 갈린다
// (이 PR의 doc-editor.tsx 쪽 주석에 붙인 puppeteer 실측 수치 참고).
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

    // ⛔올리베이라군 리뷰(2026-08-01, PR#2760) — "조상 중 overflow-y-auto가 하나도 없다"는
    // 실제 앱에서는 항상 거짓이다(페이지 셸 어딘가에 스크롤하는 조상이 늘 있다 — 유나양이
    // flow-multi-lane-canvas.test.tsx에서 정확히 이 문장을 정정한 그 자리). 겨눠야 할
    // 성질은 "오버레이와 그 containing block «사이»에 스크롤 조상이 없다"이고, 여기서는
    // `.tiptap-editor-wrapper`(`.scrollContainer()`)가 정확히 그 스크롤하는 요소이므로,
    // "오버레이가 그 요소의 자손이 아니다"만 재면 충분하다 — 더 넓게(조상 전체를) 약속하면
    // 페이지 셸이 나중에 바뀔 때 이 결함과 무관하게 빨개질 수 있다.
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
