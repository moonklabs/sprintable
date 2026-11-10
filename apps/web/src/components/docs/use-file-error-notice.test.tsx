// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #3) — a failed attach (too big · document not saved yet · upload failed) was silent: the editor forwarded the window
// event only to an `onFileError` prop the page never passes. It is an error toast now; a handler that is passed still wins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { FILE_ERROR_EVENT, useFileErrorNotice } from './use-file-error-notice';
// the upload code's own source (vite `?raw`): the name in the hook must be the name that code dispatches
import uploadSource from './extensions/image-upload.ts?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ onFileError }: { onFileError?: (m: string) => void }) {
  useFileErrorNotice(onFileError);
  return null;
}
let container: HTMLDivElement;
let root: Root;
const fire = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(FILE_ERROR_EVENT, { detail })); });

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); addToastMock.mockReset(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('useFileErrorNotice', () => {
  it('the event name is the one the upload code dispatches', () => {
    expect(uploadSource).toContain(`'${FILE_ERROR_EVENT}'`);
  });

  it('with no handler the message is shown as an error toast', () => {
    act(() => root.render(<Probe />));
    fire({ message: '파일 크기가 100MB를 초과합니다. (120 MB)' });
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith({ title: '파일 크기가 100MB를 초과합니다. (120 MB)', type: 'error' });
  });

  it('a handler that is passed gets the message and NO toast is added', () => {
    const handler = vi.fn();
    act(() => root.render(<Probe onFileError={handler} />));
    fire({ message: '문서를 먼저 저장한 후 첨부할 수 있습니다.' });
    expect(handler).toHaveBeenCalledWith('문서를 먼저 저장한 후 첨부할 수 있습니다.');
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('an event without a usable message is ignored (no empty toast)', () => {
    act(() => root.render(<Probe />));
    for (const d of [undefined, null, {}, { message: '' }, { message: '   ' }, { message: 42 }]) fire(d);
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('every event is shown (two failed attaches in a row are two toasts)', () => {
    act(() => root.render(<Probe />));
    fire({ message: 'a' });
    fire({ message: 'b' });
    expect(addToastMock.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['a', 'b']);
  });

  it('after unmount the listener is gone', () => {
    act(() => root.render(<Probe />));
    act(() => root.unmount());
    fire({ message: 'late' });
    expect(addToastMock).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
