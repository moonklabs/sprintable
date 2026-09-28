// @vitest-environment jsdom
// story #4380(PO) — 편집기(tiptap role="textbox")에 이름이 있다: 제목 칸에 글자가 있으면 그 칸이 이름(aria-labelledby · 제목을 고치면 따라감),
// 제목이 비었거나 제목 칸이 없으면 로케일 이름(docs.editorBodyLabel). 예전엔 이름 0(axe aria-input-field-name).
// 실 tiptap 편집기로 연다(useEditor 목킹 0) — 역할 + 이름으로 찾힌다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@tiptap/react/menus', () => ({ BubbleMenu: () => null }));

const { DocEditor } = await import('./doc-editor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = {
  contentFormat: 'Format', markdown: 'Markdown', preview: 'Preview', save: 'Save', toolbar: 'Toolbar',
  placeholder: 'Write something…', h1: 'H1', h2: 'H2', bold: 'Bold', italic: 'Italic', bullet: 'Bullet',
  quote: 'Quote', code: 'Code', link: 'Link', autosave: 'Autosave', undo: 'Undo', redo: 'Redo',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(title?: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocEditor value="본문" contentFormat="html" onChange={() => {}} labels={LABELS} title={title} onTitleChange={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

/** 역할이 textbox인 편집기 요소의 이름(aria-labelledby가 가리키는 칸의 값 · 아니면 aria-label) — 화면 읽기가 읽는 이름. */
function editorName(): string | null {
  const el = container.querySelector<HTMLElement>('[role="textbox"][contenteditable]');
  if (!el) return null;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const ref = document.getElementById(by) as HTMLTextAreaElement | null;
    return ref ? ref.value : null;
  }
  return el.getAttribute('aria-label');
}

describe('DocEditor — 편집기 이름(story #4380)', () => {
  it('제목이 있으면 편집기 이름 = 제목 칸(aria-labelledby) · 제목을 고치면 따라감', async () => {
    await mount('배포 절차');
    expect(editorName()).toBe('배포 절차');
    await mount('배포 절차 v2');
    expect(editorName()).toBe('배포 절차 v2');
  });

  it('제목이 비었거나 제목 칸이 없으면 로케일 이름(빈 labelledby로 이름 0이 되지 않게)', async () => {
    await mount('');
    expect(editorName()).toBe(koMessages.docs.editorBodyLabel);
    await mount(undefined);
    expect(editorName()).toBe(koMessages.docs.editorBodyLabel);
  });
});
