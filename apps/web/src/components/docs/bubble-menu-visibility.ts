import { isTextSelection, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isMobileDevice } from './mobile-selection-menu';

export interface BubbleMenuShowArgs {
  editor: Editor;
  element: HTMLElement;
  view: EditorView;
  state: EditorState;
  from: number;
  to: number;
}

/**
 * story #4368 — 데스크톱 버블 도구 줄을 보일지. 예전 `shouldShow={() => !isMobileDevice()}`는 Tiptap 기본 판정을 통째로 덮어써, 선택이
 * 없어도(커서만) 늘 떠서 커서 곁 줄(토글 화살표 · 링크 · 체크박스)을 덮고 클릭을 먹었다(7c3a1582f부터).
 * 기본 판정(@tiptap/extension-bubble-menu 3.22.3 `BubbleMenuView.shouldShow`) 그대로 + 모바일 제외(모바일은 하단 선택 메뉴가 맡음):
 * 편집기(또는 도구 줄 안)에 초점 · 선택이 비어 있지 않음 · 빈 글 블록 선택 아님 · 편집 가능.
 */
export function shouldShowDesktopBubbleMenu({ editor, element, view, state, from, to }: BubbleMenuShowArgs): boolean {
  if (isMobileDevice()) return false;
  const { doc, selection } = state;
  const isEmptyTextBlock = !doc.textBetween(from, to).length && isTextSelection(selection);
  const hasEditorFocus = view.hasFocus() || element.contains(document.activeElement);
  return hasEditorFocus && !selection.empty && !isEmptyTextBlock && editor.isEditable;
}
