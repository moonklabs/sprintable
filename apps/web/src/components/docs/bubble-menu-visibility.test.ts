// @vitest-environment jsdom
/**
 * story #4368 — 데스크톱 버블 도구 줄은 **선택이 있을 때만**(Tiptap 기본 판정) + 모바일 제외.
 * 예전 `() => !isMobileDevice()`는 커서만 있어도 true라 도구 줄이 늘 떠서 커서 곁 줄의 토글 · 링크 · 체크박스 클릭을 먹었다.
 * 실 편집기 상태로 판정한다(헤드리스 Editor · jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { shouldShowDesktopBubbleMenu } from './bubble-menu-visibility';

let editor: Editor;
let element: HTMLDivElement;

beforeEach(() => {
  editor = new Editor({ extensions: [StarterKit], content: '<p>hello world</p><p></p>' });
  element = document.createElement('div');
  document.body.appendChild(element);
  vi.spyOn(editor.view, 'hasFocus').mockReturnValue(true);
});
afterEach(() => { editor.destroy(); element.remove(); vi.restoreAllMocks(); });

function argsFor(from: number, to: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  const { state, view } = editor;
  return { editor, element, view, state, from: state.selection.from, to: state.selection.to };
}

describe('shouldShowDesktopBubbleMenu(story #4368)', () => {
  it('커서만(빈 선택)이면 안 뜬다 — 예전엔 늘 true', () => {
    expect(shouldShowDesktopBubbleMenu(argsFor(3, 3))).toBe(false);
  });

  it('글자를 고르면 뜬다', () => {
    expect(shouldShowDesktopBubbleMenu(argsFor(1, 6))).toBe(true);
  });

  it('초점이 편집기에 없으면 · 편집 불가면 안 뜬다(기본 판정 유지)', () => {
    vi.spyOn(editor.view, 'hasFocus').mockReturnValue(false);
    expect(shouldShowDesktopBubbleMenu(argsFor(1, 6))).toBe(false);
    vi.spyOn(editor.view, 'hasFocus').mockReturnValue(true);
    editor.setEditable(false);
    expect(shouldShowDesktopBubbleMenu(argsFor(1, 6))).toBe(false);
  });

  it('모바일(터치 + 좁은 화면)이면 선택이 있어도 안 뜬다(하단 선택 메뉴가 맡음)', () => {
    vi.stubGlobal('ontouchstart', null);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      expect(shouldShowDesktopBubbleMenu(argsFor(1, 6))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('문서 편집기가 이 판정을 쓴다(배선)', () => {
    const src = readFileSync(path.resolve(__dirname, 'doc-editor.tsx'), 'utf8');
    expect(src).toContain('shouldShow={(args) => shouldShowDesktopBubbleMenu(args)}');
  });
});
