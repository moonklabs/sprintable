// @vitest-environment jsdom
// story 4892 (UI-9 §5 #3) — through the REAL editor: a failed attach (the window event the upload code dispatches) is shown as an error toast
// when the page passes no `onFileError` (the doc page never does) — it used to vanish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));
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

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); addToastMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(onFileError?: (m: string) => void) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocEditor value="본문" contentFormat="html" onChange={() => {}} labels={LABELS} onFileError={onFileError} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const fire = (message: string) => act(() => { window.dispatchEvent(new CustomEvent('docs:file-size-error', { detail: { message } })); });

describe('DocEditor — a failed attach is shown (4892 §5 #3)', () => {
  it('no handler passed → an error toast carries the message', async () => {
    await mount();
    fire('파일 크기가 100MB를 초과합니다. (130 MB)');
    expect(addToastMock).toHaveBeenCalledWith({ title: '파일 크기가 100MB를 초과합니다. (130 MB)', type: 'error' });
  });

  it('a handler that is passed still gets it, with no toast', async () => {
    const handler = vi.fn();
    await mount(handler);
    fire('문서를 먼저 저장한 후 첨부할 수 있습니다.');
    expect(handler).toHaveBeenCalledWith('문서를 먼저 저장한 후 첨부할 수 있습니다.');
    expect(addToastMock).not.toHaveBeenCalled();
  });
});
