// @vitest-environment jsdom
//
// story #3917 — 문서 편집기 빈 상태에서 두 안내 문구가 겹쳐 그려지던 결함(3909 AC4
// 캡처 artifact 3ee688e0에서 발견). 원인: doc-editor.tsx가 (a) Tiptap `Placeholder`
// 확장의 CSS ::before 문구(labels.placeholder="/" 입력으로 블록 추가...)와 (b) 별도
// 절대배치 <p>(attachEmptyHint="이미지·파일을 끌어다 놓거나...") 둘 다를 `editable &&
// isEmpty`(둘 다 같은 조건, 드래그와 무관) 상태에서 동시에 그렸다 — 같은 좌상단 자리에
// 겹침. 처방: (b)를 제거하고 그 정보를 (a) 하나로 병합(한 상태=한 안내 불변식).
//
// jsdom 갭(doc-editor.dragdrop.test.tsx 머리말과 동형 고지) — 실제 Tiptap/ProseMirror는
// jsdom이 못 주는 DOM API를 요구해 useEditor/EditorContent를 얇게 스텁한다(editor=null).
// 그래서 이 테스트는 (a)의 실제 CSS ::before 렌더 자체는 못 재지만, doc-editor.tsx가
// useEditor에 넘기는 **설정값**(extensions 배열의 Placeholder.options.placeholder)과
// 컴포넌트가 직접 그리는 나머지 DOM 구조(더 이상 중복 <p>가 없음)는 정확히 잴 수 있다.
// 픽셀 수준 겹침 소거의 최종 증거는 AC4 실 화면 캡처(빈 문서·드래그 중) 2장.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

let capturedExtensions: Array<{ name: string; options?: Record<string, unknown> }> = [];

vi.mock('@tiptap/react', () => ({
  useEditor: (config: { extensions: Array<{ name: string; options?: Record<string, unknown> }> }) => {
    capturedExtensions = config.extensions;
    return null;
  },
  EditorContent: () => <div data-testid="editor-content-stub" />,
}));
vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: () => null,
}));

const { DocEditor } = await import('./doc-editor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, messages: typeof koMessages, locale: string) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
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
  capturedExtensions = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('DocEditor — story #3917: 빈 문서 안내는 한 자리에 하나(겹침 회귀가드)', () => {
  it('컴포넌트가 직접 그리는 DOM에는 중복 절대배치 안내 문단이 더 이상 없다(예전 attachEmptyHint <p> 제거 확認)', async () => {
    await act(async () => {
      root.render(wrap(<DocEditor value="" contentFormat="markdown" onChange={() => {}} labels={LABELS} />, koMessages, 'ko'));
    });
    // editor-content-stub 하나만 있고, 그 형제로 절대배치 안내 <p>가 없어야 한다.
    const wrapperEl = container.querySelector('.tiptap-editor-wrapper');
    expect(wrapperEl).not.toBeNull();
    const paragraphs = wrapperEl!.querySelectorAll('p.absolute, p[class*="absolute"]');
    expect(paragraphs.length).toBe(0);
  });

  it('Placeholder 확장이 정확히 하나만 등록됐고, 그 문구가 labels.placeholder와 일치한다(드래그·"/" 안내가 한 문자열로 병합)', async () => {
    await act(async () => {
      root.render(wrap(<DocEditor value="" contentFormat="markdown" onChange={() => {}} labels={LABELS} />, koMessages, 'ko'));
    });
    const placeholderExts = capturedExtensions.filter((e) => e.name === 'placeholder');
    expect(placeholderExts).toHaveLength(1);
    expect(placeholderExts[0]!.options?.placeholder).toBe(LABELS.placeholder);
  });

  it('실 ko.json editorPlaceholder가 "/" 안내와 끌어다 놓기 안내를 한 문자열로 담는다(병합 확認)', () => {
    const value = (koMessages.docs as Record<string, string>).editorPlaceholder;
    expect(value).toContain('/');
    expect(value).toContain('끌어다');
  });

  it('실 en.json editorPlaceholder도 동형 병합 — drag 안내를 포함한다', () => {
    const value = (enMessages.docs as Record<string, string>).editorPlaceholder;
    expect(value.toLowerCase()).toContain('drag');
    expect(value).toContain('/');
  });

  it('attachEmptyHint 키는 ko.json/en.json 양쪽 모두에서 소비처가 없어져 삭제됐다(고아 키 0)', () => {
    expect((koMessages.docs as Record<string, unknown>).attachEmptyHint).toBeUndefined();
    expect((enMessages.docs as Record<string, unknown>).attachEmptyHint).toBeUndefined();
  });
});
