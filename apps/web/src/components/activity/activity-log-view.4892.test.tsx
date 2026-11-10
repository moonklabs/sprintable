// @vitest-environment jsdom
// story 4892 (UI-9 §5 item 6) — the audit log's «더 보기» swallowed a failure (refused answer: nothing; network error: an empty catch).
// It is the same shared error toast the team activity feed uses, the list stays as it was, and pressing the button again asks again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ko = koMessages as unknown as { common: { loadMoreFailed: string }; activityLog: { loadMore: string } };

let container: HTMLDivElement;
let root: Root;

const row = (id: string) => ({
  id, actor_id: 'm1', actor_name: '안나', actor_type: 'human', action: 'story.updated', entity_type: 'story', entity_title: `일감 ${id}`,
  context: null, created_at: '2026-09-26T00:00:00Z',
});
const page = (ids: string[], total: number, offset: number) => ({ ok: true, status: 200, json: async () => ({ data: { items: ids.map(row), total, limit: 30, offset } }) });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  addToastMock.mockClear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  fetchWithAuthMock.mockReset();
});

// the first page answers fine (total 100 → the «더 보기» button shows); the second page is what the test decides
async function mount(second: () => unknown) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('offset=30')) return second();
    return page(['a1', 'a2'], 100, 0);
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <ActivityLogView projectId="p1" />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const moreButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === ko.activityLog.loadMore);
const press = async () => { await act(async () => { moreButton()!.click(); }); for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const secondPageCalls = () => fetchWithAuthMock.mock.calls.filter(([u]) => String(u).includes('offset=30')).length;

describe('ActivityLogView — «더 보기» failure (4892 §5 item 6)', () => {
  it('a refused answer (server error) shows the shared error toast; the list stays and the button stays', async () => {
    await mount(() => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(moreButton()).toBeTruthy();
    const before = container.querySelectorAll('[aria-label]').length;
    await press();
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith({ title: ko.common.loadMoreFailed, type: 'error' });
    expect(container.querySelectorAll('[aria-label]').length).toBe(before);
    expect(moreButton()).toBeTruthy();
  });

  it('a network error is the same toast', async () => {
    await mount(() => { throw new Error('network down'); });
    await press();
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith({ title: ko.common.loadMoreFailed, type: 'error' });
    expect(moreButton()).toBeTruthy();
  });

  it('pressing again after a failure asks again (the offset did not move), and a good answer adds the rows with no toast', async () => {
    let calls = 0;
    await mount(() => (++calls === 1 ? { ok: false, status: 502, json: async () => ({}) } : page(['b1', 'b2'], 100, 30)));
    await press();
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(secondPageCalls()).toBe(1);
    const before = container.querySelectorAll('[aria-label]').length;
    await press();
    expect(secondPageCalls()).toBe(2);                       // same offset=30 again
    expect(addToastMock).toHaveBeenCalledTimes(1);           // no second toast
    expect(container.querySelectorAll('[aria-label]').length).toBeGreaterThan(before);
  });

  it('a good second page shows no toast', async () => {
    await mount(() => page(['b1'], 100, 30));
    await press();
    expect(addToastMock).not.toHaveBeenCalled();
  });
});
