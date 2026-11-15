// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #4) — a failed delete was swallowed by an empty catch (nothing happened, nothing said). It is an error toast now and the
// document stays; a delete that worked still removes the row from the tree and goes to the list; «cancel» in the confirm does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { useDocDelete } from './use-doc-delete';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ko = koMessages as unknown as { docs: { confirmDelete: string; deleteFailed: string } };

let container: HTMLDivElement;
let root: Root;
let run: () => Promise<void>;
const replace = vi.fn();
const setTree = vi.fn();
const fetchMock = vi.fn();
const confirmMock = vi.fn();

type ProbeProps = { docId: string | undefined; projectId: string | undefined };
function Probe({ docId, projectId }: ProbeProps) {
  const handler = useDocDelete({ docId, projectId, wsSlug: 'ws', projSlug: 'proj', router: { replace }, setTree });
  useEffect(() => { run = handler; });
  return null;
}
// both are passed explicitly: a default parameter would turn an explicit `undefined` back into a value
async function mount(props: ProbeProps = { docId: 'doc-1', projectId: 'proj-1' }) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Probe {...props} /></NextIntlClientProvider>);
  });
}
const deleteIt = () => act(async () => { await run(); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  addToastMock.mockReset(); replace.mockReset(); setTree.mockReset(); fetchMock.mockReset(); confirmMock.mockReset();
  confirmMock.mockReturnValue(true);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', confirmMock);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('useDocDelete — a failed delete is shown (4892 §5 #4)', () => {
  it('the server refuses (not ok) → an error toast, the tree and the page are untouched', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await mount();
    await deleteIt();
    expect(addToastMock).toHaveBeenCalledWith({ title: ko.docs.deleteFailed, type: 'error' });
    expect(setTree).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a network error is the same', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await mount();
    await deleteIt();
    expect(addToastMock).toHaveBeenCalledWith({ title: ko.docs.deleteFailed, type: 'error' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('a delete that worked removes the row from the tree, goes to the list, and shows no error', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await mount();
    await deleteIt();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/docs/doc-1');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    const updater = setTree.mock.calls[0]![0] as (p: { id: string }[]) => { id: string }[];
    expect(updater([{ id: 'doc-1' }, { id: 'doc-2' }])).toEqual([{ id: 'doc-2' }]);
    expect(replace).toHaveBeenCalledWith('/ws/proj/docs');
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('«cancel» in the confirm: no request, no toast, nothing moves (and the question is the document one)', async () => {
    confirmMock.mockReturnValue(false);
    await mount();
    await deleteIt();
    expect(confirmMock).toHaveBeenCalledWith(ko.docs.confirmDelete);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addToastMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('without a document or a project nothing is asked and nothing is sent', async () => {
    await mount({ docId: '', projectId: 'proj-1' });
    await deleteIt();
    await mount({ docId: 'doc-1', projectId: undefined });
    await deleteIt();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
