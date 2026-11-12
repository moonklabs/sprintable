// @vitest-environment jsdom
//
// story 4912 D1 — a FAILED read of the org agent list used to return silently and the list said «조직에 등록된 에이전트가 없어요» (an error read as «none»).
// Now a non-OK answer shows the error state with [다시 시도], and the retry reads again. Reverting the strict read makes the first two go red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

// story 4912 — the rows open the detail through the router (Enter / double click): a stub router, the push is not under test here
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => ({ rows: [], loaded: true, readAt: Date.now() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

// the first answer of the agent list is `firstStatus`; later ones are 200 with one agent
function stubFetch(firstStatus: number) {
  let listCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/me') return new Response(JSON.stringify({ data: { role: 'admin' } }), { status: 200 });
    if (url === '/api/projects') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.startsWith('/api/team-members?')) {
      listCalls += 1;
      return listCalls === 1 && firstStatus !== 200
        ? new Response('{}', { status: firstStatus })
        : new Response(JSON.stringify({ data: [{ id: 'a1', name: '일하는 에이전트', role: 'member', is_active: true }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
  return () => listCalls;
}
async function mount() {
  const { AgentManagementTab } = await import('./agent-management-tab');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const retryBtn = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === koMessages.common.retry) as HTMLButtonElement | undefined;

describe('에이전트 목록 읽기 실패(story 4912 D1)', () => {
  it('⭐a failed read (500) shows the error + [다시 시도] and does NOT say «등록된 에이전트가 없어요» — reverting the strict read turns this red', async () => {
    stubFetch(500);
    await mount();
    expect(container.textContent).toContain(koMessages.common.error);
    expect(retryBtn()).toBeTruthy();
    expect(container.textContent).not.toContain(koMessages.settings.noOrgAgents);
  });

  it('⭐[다시 시도] reads again and the list appears (the error is gone)', async () => {
    const calls = stubFetch(503);
    await mount();
    await act(async () => { retryBtn()?.click(); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(calls()).toBe(2);
    expect(container.textContent).toContain('일하는 에이전트');
    expect(retryBtn()).toBeUndefined();
  });

  it('a read that works is unchanged: the list is there, no error', async () => {
    stubFetch(200);
    await mount();
    expect(container.textContent).toContain('일하는 에이전트');
    expect(container.textContent).not.toContain(koMessages.common.error);
  });
});
