// @vitest-environment jsdom
//
// 4910 — «새 문서» 제목칸: 페이지가 막 만든 초안에는 title='' + titlePlaceholder='제목 없음'을 넘긴다(page.new-doc-draft.4910.test.tsx). 여기서는 진짜 DocEditor의
// 제목 textarea가 그 두 값을 그대로 쓰는지 — 칸은 비어 있고 «제목 없음»은 placeholder, 쓰면 onTitleChange에 쓴 글 그대로(뒤에 붙지 않음) — 를 지킨다.
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
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(over: Partial<React.ComponentProps<typeof DocEditor>>) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocEditor value="" contentFormat="markdown" onChange={() => {}} labels={LABELS} {...over} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const titleField = () => container.querySelector('header textarea') as HTMLTextAreaElement;
const type = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('DocEditor 제목칸 — 값 · placeholder (4910)', () => {
  it('title="" + titlePlaceholder: 칸은 비어 있고 안내 글이 placeholder로 — 쓴 글 그대로 onTitleChange로 간다', async () => {
    const onTitleChange = vi.fn();
    await mount({ title: '', titlePlaceholder: '제목 없음', onTitleChange });
    expect(titleField().value).toBe('');
    expect(titleField().getAttribute('placeholder')).toBe('제목 없음');
    await type(titleField(), '분기 회고');
    expect(onTitleChange).toHaveBeenCalledWith('분기 회고');
  });

  it('title이 값이면 그대로 보인다(placeholder는 안 가림)', async () => {
    await mount({ title: '제목 없음', titlePlaceholder: '제목', onTitleChange: () => {} });
    expect(titleField().value).toBe('제목 없음');
    expect(titleField().getAttribute('placeholder')).toBe('제목');
  });
});
