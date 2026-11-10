// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #2) — `/docs?id=<doc id>` is the link form chat cards, the sprint report link and the intent-suggestion card carry
// (the proxy sends it on to `/{ws}/{proj}/docs?id=…`). Nothing in the docs area read `id`, so the link landed on the index. The page now
// resolves the id (the same `/api/docs/preview?q=` call the chat embed card makes) and opens that document.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { replaceMock, fetchMock, searchState } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  fetchMock: vi.fn(),
  searchState: { qs: '' },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useParams: () => ({ ws: 'moonklabs', proj: 'sprintable' }),
  useSearchParams: () => new URLSearchParams(searchState.qs),
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('./docs-index', () => ({ DocsIndex: () => <div data-testid="docs-index" /> }));

import DocsPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => { root.render(<DocsPage />); });
  await act(async () => { await Promise.resolve(); });
}
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  replaceMock.mockReset();
  fetchMock.mockReset();
  searchState.qs = '';
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('/docs?id=<doc id>', () => {
  it('opens the document the id points to (the index stays up while it resolves)', async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000001';
    fetchMock.mockResolvedValue(ok({ id: '0a1b2c3d-0000-4000-8000-000000000001', slug: 'prd-v2', orgSlug: 'moonklabs', projectSlug: 'sprintable' }));
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/docs/preview?q=0a1b2c3d-0000-4000-8000-000000000001');
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/prd-v2');
    expect(container.querySelector('[data-testid="docs-index"]')).not.toBeNull();
  });

  it("uses the document's own project when the preview names one (a link to another project's document)", async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000002';
    fetchMock.mockResolvedValue(ok({ slug: 'runbook', orgSlug: 'moonklabs', projectSlug: 'other-proj' }));
    await render();
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/other-proj/docs/runbook');
  });

  it('falls back to the current project when the preview does not name one', async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000003';
    fetchMock.mockResolvedValue(ok({ slug: 'notes', orgSlug: null, projectSlug: null }));
    await render();
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/notes');
  });

  it('a slug is encoded, never trusted as a path', async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000004';
    fetchMock.mockResolvedValue(ok({ slug: 'a/b?c', orgSlug: 'moonklabs', projectSlug: 'sprintable' }));
    await render();
    expect(replaceMock).toHaveBeenCalledWith('/moonklabs/sprintable/docs/a%2Fb%3Fc');
  });

  it('stays on the index when the id does not resolve (answer not ok · network error · no slug)', async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000005';
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await render();
    expect(replaceMock).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await render();
    expect(replaceMock).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    fetchMock.mockResolvedValueOnce(ok({ slug: '' }));
    await render();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="docs-index"]')).not.toBeNull();
  });

  it('without an id nothing is fetched and nothing moves', async () => {
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('an empty or blank id is ignored', async () => {
    searchState.qs = 'id=%20%20';
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the page before the answer lands: nothing moves afterwards', async () => {
    searchState.qs = 'id=0a1b2c3d-0000-4000-8000-000000000006';
    let release: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((r) => { release = r; }));
    await render();
    act(() => root.unmount());
    await act(async () => { release(ok({ slug: 'late', orgSlug: 'moonklabs', projectSlug: 'sprintable' })); await Promise.resolve(); });
    expect(replaceMock).not.toHaveBeenCalled();
    root = createRoot(container); // for afterEach
  });
});
