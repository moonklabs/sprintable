// @vitest-environment jsdom
/**
 * story 5042 (C9) — the work-item tab's page as a person gets it: the read of the agent's member row, the states, the reading view drawn BARE (no close · no link out), the poll, and a late answer dropped.
 * Only the network and the reading view itself (a heavy component with its own tests) are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), views: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/components/chat/embed-card', () => ({
  EntityPreviewModal: (p: Record<string, unknown>) => { mocks.views.push(p); return <div data-testid="reading-view" data-id={String(p.entityId)} />; },
}));

import { WorkItemPanel } from './work-item-panel';
import { POLL_MS } from './use-panel-work-item';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const AGENT = '11111111-1111-4111-8111-111111111111';
const S1 = '7e0e7cc1-c2b8-4669-bfaa-3b13903fd670';
const S2 = '8f1f8dd2-d3c9-4770-8cbb-4c24a14e0781';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;
const refuse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

let container: HTMLDivElement; let root: Root; let answer: () => Response | Promise<Response>;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.views.length = 0;
  answer = () => ok({ id: AGENT, active_story_id: S1 });
  mocks.fetchWithAuth.mockImplementation(async () => answer());
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); mocks.fetchWithAuth.mockReset(); vi.useRealTimers(); });

const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
async function mount(agentId = AGENT) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><WorkItemPanel agentId={agentId} /></NextIntlClientProvider>); });
  await flush();
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('WorkItemPanel (container)', () => {
  it('⭐the agent\'s story is drawn with the reading view BARE: a story, embedded, no close · no link out — and the read is the member row of THAT agent only', async () => {
    await mount();
    expect(q('reading-view')!.dataset.id).toBe(S1);
    const p = mocks.views.at(-1)!;
    expect(p).toMatchObject({ entityType: 'story', entityId: S1, embedded: true, bare: true });
    expect(mocks.fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([`/api/team-members/${AGENT}`]);
  });
  it('⭐the agent has no story now → one line, no reading view (the server\'s own answer, not an error)', async () => {
    answer = () => ok({ id: AGENT, active_story_id: null });
    await mount();
    expect(q('panel-none')!.textContent).toBe('지금 하고 있는 일감이 없어요');
    expect(q('reading-view')).toBeNull(); expect(q('panel-error')).toBeNull();
  });
  it('⭐the read fails → an error with a retry (never «no work item»); the retry reads again and shows the story', async () => {
    answer = () => refuse(500);
    await mount();
    expect(q('panel-error')).not.toBeNull(); expect(q('panel-none')).toBeNull();
    answer = () => ok({ id: AGENT, active_story_id: S1 });
    await act(async () => { (q('panel-error')!.querySelector('button') as HTMLButtonElement).click(); });
    await flush();
    expect(q('reading-view')!.dataset.id).toBe(S1);
  });
  it('⭐a person who may not see the agent (403) or an agent that is not there (404) gets «대상을 찾을 수 없어요.» — the same line as the reading view and the C4 refusal — no retry button, never the error banner; the story is never asked for', async () => {
    for (const status of [403, 404]) {
      mocks.fetchWithAuth.mockClear(); mocks.views.length = 0;
      answer = () => refuse(status);
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await mount();
      expect(q('panel-not-found')!.textContent, String(status)).toBe('대상을 찾을 수 없어요.');
      expect(q('panel-error'), String(status)).toBeNull(); expect(q('reading-view')).toBeNull();
      expect(mocks.fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([`/api/team-members/${AGENT}`]);
    }
  });
  it('⭐access taken away while a story is shown: the next poll answers 403 → the story goes, «찾을 수 없어요» stays (a 5xx keeps the story, as before)', async () => {
    await mount();
    expect(q('reading-view')).not.toBeNull();
    answer = () => refuse(403);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await flush();
    expect(q('panel-not-found')).not.toBeNull(); expect(q('reading-view')).toBeNull();
  });
  it('an answer that is not a member row is an error too (not «no work item»)', async () => {
    answer = () => ok(['x']);
    await mount();
    expect(q('panel-error')).not.toBeNull();
  });
  it('⭐an address that is not a uuid is never opened and never read', async () => {
    await mount('../me');
    expect(q('panel-bad-address')).not.toBeNull();
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
  });
  it('⭐the poll: the agent moves on to the next story → the reading view is that story (a new view); a failed poll keeps what is shown', async () => {
    await mount();
    answer = () => ok({ id: AGENT, active_story_id: S2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await flush();
    expect(q('reading-view')!.dataset.id).toBe(S2);
    answer = () => refuse(503);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await flush();
    expect(q('reading-view')!.dataset.id).toBe(S2); expect(q('panel-error')).toBeNull();
  });
  it('⭐a page that is gone before its first read\'s turn never starts that read (codex: the queued first read must not run after the cleanup)', async () => {
    const local = createRoot(document.createElement('div'));
    act(() => { local.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><WorkItemPanel agentId={AGENT} /></NextIntlClientProvider>); });
    act(() => { local.unmount(); }); // both synchronous: the queued microtask has not had its turn yet
    await flush();
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
  });
  it('⭐a late answer of an OLDER read is dropped (the retry\'s answer stands)', async () => {
    let release!: (r: Response) => void;
    answer = () => new Promise<Response>((r) => { release = r; });
    await mount(); // the first read is held
    const first = release;
    answer = () => ok({ id: AGENT, active_story_id: S2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await flush();
    expect(q('reading-view')!.dataset.id).toBe(S2);
    first(ok({ id: AGENT, active_story_id: S1 })); // the old one lands last
    await flush();
    expect(q('reading-view')!.dataset.id).toBe(S2);
  });
});
