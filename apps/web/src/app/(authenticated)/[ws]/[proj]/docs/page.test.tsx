// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #2) — `/docs?id=<doc id>` is the link form chat cards, the sprint report link and the intent-suggestion card carry
// (the proxy sends it on to `/{ws}/{proj}/docs?id=…`). Nothing in the docs area read `id`, so the link landed on the index. The page now
// resolves the id (the same `/api/docs/preview?q=` call the chat embed card makes) and opens that document. The pure rules for «where»
// (project matching, slug checks) are pinned in components/docs/lib/doc-link-target.test.ts.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { replaceMock, fetchMock, searchState, layoutState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  fetchMock: vi.fn(),
  searchState: { qs: '' },
  layoutState: { projectId: 'proj-cur' as string | undefined },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useParams: () => ({ ws: 'moonklabs', proj: 'sprintable' }),
  useSearchParams: () => new URLSearchParams(searchState.qs),
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('./docs-index', () => ({ DocsIndex: () => <div data-testid="docs-index" /> }));
vi.mock('./docs-context', () => ({ useDocsLayout: () => layoutState }));

import DocsPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const ID = '0a1b2c3d-0000-4000-8000-0000000000';
async function render(strict = false) {
  await act(async () => { root.render(strict ? <StrictMode><DocsPage /></StrictMode> : <DocsPage />); });
  await act(async () => { await Promise.resolve(); });
}
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const here = { projectId: 'proj-cur', orgSlug: 'moonklabs', projectSlug: 'sprintable' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  replaceMock.mockReset();
  fetchMock.mockReset();
  searchState.qs = '';
  layoutState.projectId = 'proj-cur';
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('/docs?id=<doc id>', () => {
  it('opens the document the id points to (the index stays up while it resolves)', async () => {
    searchState.qs = `id=${ID}01`;
    fetchMock.mockResolvedValue(ok({ id: `${ID}01`, slug: 'prd-v2', ...here }));
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/docs/preview?q=${ID}01`);
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/prd-v2/view');
    expect(container.querySelector('[data-testid="docs-index"]')).not.toBeNull();
  });

  it('an id that is a SLUG (not a uuid) is asked the same way and opens', async () => {
    searchState.qs = 'id=prd-v2';
    fetchMock.mockResolvedValue(ok({ id: 'd-1', slug: 'prd-v2', ...here }));
    await render();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/docs/preview?q=prd-v2');
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/prd-v2/view');
  });

  it("a document of another project opens in ITS project (the answer's own slug)", async () => {
    searchState.qs = `id=${ID}02`;
    fetchMock.mockResolvedValue(ok({ slug: 'runbook', projectId: 'proj-x', orgSlug: 'moonklabs', projectSlug: 'other-proj' }));
    await render();
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/other-proj/docs/runbook/view');
  });

  it('another project that has no slug is NOT guessed as the current one — the index stays', async () => {
    searchState.qs = `id=${ID}03`;
    fetchMock.mockResolvedValue(ok({ slug: 'runbook', projectId: 'proj-x', orgSlug: 'moonklabs', projectSlug: null }));
    await render();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('a server answer that does not look like slugs never becomes a path', async () => {
    searchState.qs = `id=${ID}04`;
    fetchMock.mockResolvedValue(ok({ slug: 'd', projectId: 'proj-x', orgSlug: '../evil', projectSlug: 'a/b' }));
    await render();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('stays on the index when the id does not resolve (answer not ok · network error · no slug)', async () => {
    searchState.qs = `id=${ID}05`;
    for (const next of [
      () => fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) }),
      () => fetchMock.mockRejectedValueOnce(new Error('network')),
      () => fetchMock.mockResolvedValueOnce(ok({ slug: '', ...here })),
    ]) {
      fetchMock.mockReset();
      next();
      root = createRoot(container);
      await render();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replaceMock).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="docs-index"]')).not.toBeNull();
      act(() => root.unmount());
    }
    root = createRoot(container);
  });

  it('a network error is handled inside the page: no unhandled rejection leaves it (and the request WAS made)', async () => {
    searchState.qs = `id=${ID}06`;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      fetchMock.mockRejectedValue(new Error('network down'));
      await render();
      await new Promise((r) => setImmediate(r)); // a rejection nobody handles is reported on the next turn of the event loop
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(replaceMock).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('without an id nothing is fetched and nothing moves; a blank id is ignored too', async () => {
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    searchState.qs = 'id=%20%20';
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('leaves the page before the answer lands: the request is cancelled and nothing moves afterwards', async () => {
    searchState.qs = `id=${ID}07`;
    let release: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((r) => { release = r; }));
    await render();
    const signal = (fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => { release(ok({ slug: 'late', ...here })); await Promise.resolve(); });
    expect(replaceMock).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("React's development double run (StrictMode): the first request is cancelled, the document opens ONCE", async () => {
    searchState.qs = `id=${ID}08`;
    fetchMock.mockImplementation(async () => ok({ slug: 'once', ...here }));
    await render(true);
    const signals = fetchMock.mock.calls.map((c) => (c[1] as { signal: AbortSignal }).signal);
    expect(signals.length).toBe(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/once/view');
  });

  it('a changed id while the page stays mounted: the old request is cancelled, only the new document opens', async () => {
    searchState.qs = `id=${ID}09`;
    let releaseFirst: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((r) => { releaseFirst = r; }));
    await render();
    const first = (fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    searchState.qs = `id=${ID}10`;
    fetchMock.mockResolvedValueOnce(ok({ slug: 'second', ...here }));
    await render();
    expect(first.aborted).toBe(true);
    await act(async () => { releaseFirst(ok({ slug: 'first', ...here })); await Promise.resolve(); });
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/second/view');
  });
});
