// @vitest-environment jsdom
//
// story 4892 (UI-9 §5 #1) — a first page that fails to load was shown as «아직 활동이 없어요» (the empty state): the load turned every failed answer
// into an empty list. It is an error state now, with a retry that asks again. A real empty answer is still the empty state; 403 is still «접근 불가».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TeamActivityView } from './team-activity-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args) }));
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));
import { resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const ko = koMessages as unknown as { common: { error: string; errorDescription: string; retry: string }; teamActivity: { emptyTitle: string; forbiddenTitle: string } };

const item = (seq: number) => ({
  activity_id: `a${seq}`, project_id: 'p1', actor_id: null, verb: 'updated', object_type: 'doc', object_id: `d${seq}`,
  occurred_at: new Date().toISOString(), source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: seq,
});
type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (ok: boolean, status: number, data?: unknown): Answer => ({ ok, status, json: async () => ({ data }) });
function stream(handler: () => Answer | Promise<Answer>) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return answer(true, 200, []);
    if (url.includes('/api/activity-stream')) return handler();
    return answer(false, 404);
  });
}
async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><TeamActivityView projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
const streamCalls = () => fetchWithAuthMock.mock.calls.filter((c) => String(c[0]).includes('/api/activity-stream')).length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  resetOrgMembersCacheForTests();
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  dashCtx.value = {};
});

describe('TeamActivityView — first page failure (4892 §5 #1)', () => {
  it('a failed first page (server error) is an error state with a retry — NOT «아직 활동이 없어요»', async () => {
    stream(() => answer(false, 500));
    await mount();
    expect(text()).toContain(ko.common.error);
    expect(text()).not.toContain(ko.teamActivity.emptyTitle);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === ko.common.retry)).toBe(true);
  });

  it('a network error is the same error state', async () => {
    stream(() => { throw new Error('network down'); });
    await mount();
    expect(text()).toContain(ko.common.errorDescription);
    expect(text()).not.toContain(ko.teamActivity.emptyTitle);
  });

  it('«다시 시도» asks again, and the list shows when the second answer is good', async () => {
    let calls = 0;
    stream(() => (++calls === 1 ? answer(false, 502) : answer(true, 200, { items: [item(5)], next_after_seq: null })));
    await mount();
    expect(streamCalls()).toBe(1);
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === ko.common.retry)!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(streamCalls()).toBe(2);
    expect(text()).not.toContain(ko.common.error);
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('a retry that fails again stays an error state (never the empty state)', async () => {
    stream(() => answer(false, 503));
    await mount();
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === ko.common.retry)!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(text()).toContain(ko.common.error);
    expect(text()).not.toContain(ko.teamActivity.emptyTitle);
  });

  it('a REAL empty answer is still the empty state, and a 403 is still «접근 불가» (not the error state)', async () => {
    stream(() => answer(true, 200, { items: [], next_after_seq: null }));
    await mount();
    expect(text()).toContain(ko.teamActivity.emptyTitle);
    expect(text()).not.toContain(ko.common.error);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stream(() => answer(false, 403));
    await mount();
    expect(text()).toContain(ko.teamActivity.forbiddenTitle);
    expect(text()).not.toContain(ko.common.error);
  });

  it('a stale first-page ERROR from before a retry never overwrites the list the retry loaded', async () => {
    const pending: Array<(a: Answer) => void> = [];
    stream(() => new Promise<Answer>((r) => { pending.push(r); }));
    await mount();                                   // call 1 is in flight (no answer yet)
    expect(pending.length).toBe(1);
    // the person changes the end date → a NEW first page is asked for (generation 2) while the first is still in flight
    const dates = Array.from(container.querySelectorAll('input[type="date"]'));
    expect(dates.length).toBeGreaterThan(0);
    const to = dates[dates.length - 1] as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(to, '2026-01-01'); to.dispatchEvent(new Event('input', { bubbles: true })); to.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
    expect(pending.length).toBe(2);
    await act(async () => { pending[1]!(answer(true, 200, { items: [item(7)], next_after_seq: null })); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
    await act(async () => { pending[0]!(answer(false, 500)); await Promise.resolve(); await Promise.resolve(); });
    expect(text()).not.toContain(ko.common.error);   // the old call's failure is dropped
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('a RETRY still in flight when a newer filter load succeeds: the retry\'s late error never overwrites that list', async () => {
    const pending: Array<(a: Answer) => void> = [];
    let calls = 0;
    stream(() => (++calls === 1 ? Promise.resolve(answer(false, 500)) : new Promise<Answer>((r) => { pending.push(r); })));
    await mount();
    expect(text()).toContain(ko.common.error);               // call 1 failed → error state
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === ko.common.retry)!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(pending.length).toBe(1);                          // call 2 (the retry) is in flight
    const dates = Array.from(container.querySelectorAll('input[type="date"]'));
    const to = dates[dates.length - 1] as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(to, '2026-01-03'); to.dispatchEvent(new Event('input', { bubbles: true })); to.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
    expect(pending.length).toBe(2);                          // call 3 (the newer filter) is in flight too
    await act(async () => { pending[1]!(answer(true, 200, { items: [item(11)], next_after_seq: null })); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
    await act(async () => { pending[0]!(answer(false, 500)); await Promise.resolve(); await Promise.resolve(); });   // the retry's late failure
    expect(text()).not.toContain(ko.common.error);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('changing a filter while the error is shown asks again (the error does not stick)', async () => {
    let calls = 0;
    stream(() => (++calls === 1 ? answer(false, 500) : answer(true, 200, { items: [item(3)], next_after_seq: null })));
    await mount();
    expect(text()).toContain(ko.common.error);
    const dates = Array.from(container.querySelectorAll('input[type="date"]'));
    const to = dates[dates.length - 1] as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(to, '2026-01-02'); to.dispatchEvent(new Event('input', { bubbles: true })); to.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(streamCalls()).toBe(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('the error clears when a new first page loads fine (no error banner left over a good list)', async () => {
    let calls = 0;
    stream(() => (++calls === 1 ? answer(false, 500) : answer(true, 200, { items: [item(9)], next_after_seq: null })));
    await mount();
    expect(text()).toContain(ko.common.error);
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === ko.common.retry)!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
