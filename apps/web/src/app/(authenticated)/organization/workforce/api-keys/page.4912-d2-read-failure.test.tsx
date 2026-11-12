// @vitest-environment jsdom
//
// story 4912 D2 — the API key page's agent read: a failed read returned silently and the page said «활성 에이전트가 없어요» (an error read as «none»); and the wording said «프로젝트» although the read is org-wide.
// Now: a failed read says so with [다시 시도]; the empty wording says «조직». Reverting either turns the matching test red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import ApiKeysPage from './page';

vi.mock('@/components/agents/agent-api-key-manager', () => ({
  AgentApiKeyManager: ({ agentName }: { agentName: string }) => <div data-testid="stub-agent-api-key-manager">{agentName}</div>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ApiKeysPage /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const retryBtn = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === koMessages.common.retry) as HTMLButtonElement | undefined;
const answers = (...rs: Array<() => Response | Promise<Response>>) => {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async () => rs[Math.min(i++, rs.length - 1)]()));
};
const ok = (data: unknown[]) => () => new Response(JSON.stringify({ data }), { status: 200 });

describe('API 키 화면 에이전트 읽기(story 4912 D2)', () => {
  it('⭐a failed read (500) says the read failed + [다시 시도] and does NOT say «활성 에이전트가 없어요»', async () => {
    answers(() => new Response('{}', { status: 500 }));
    await mount();
    expect(container.querySelector('[data-testid="api-keys-load-failed"]')).toBeTruthy();
    expect(container.textContent).toContain(koMessages.settings.agentApiKeysLoadFailed);
    expect(container.textContent).not.toContain(koMessages.settings.agentApiKeysNoAgents);
    expect(retryBtn()).toBeTruthy();
  });

  it('⭐a read that REJECTS (network) is the same failure state, not an empty list', async () => {
    answers(() => { throw new Error('network'); });
    await mount();
    expect(container.querySelector('[data-testid="api-keys-load-failed"]')).toBeTruthy();
    expect(container.textContent).not.toContain(koMessages.settings.agentApiKeysNoAgents);
  });

  it('⭐[다시 시도] reads again and the agents appear', async () => {
    answers(() => new Response('{}', { status: 500 }), ok([{ id: 'a1', name: '실 에이전트', type: 'agent', is_active: true, runtime_type: 'claude-code' }]));
    await mount();
    await act(async () => { retryBtn()?.click(); });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(container.querySelector('[data-testid="stub-agent-api-key-manager"]')?.textContent).toBe('실 에이전트');
    expect(container.querySelector('[data-testid="api-keys-load-failed"]')).toBeNull();
  });

  it('⭐a real empty list says «조직» (the read is org-wide), not «프로젝트»', async () => {
    answers(ok([]));
    await mount();
    expect(container.textContent).toContain(koMessages.settings.agentApiKeysNoAgents);
    expect(koMessages.settings.agentApiKeysNoAgents).toContain('조직');
    expect(koMessages.settings.agentApiKeysNoAgents).not.toContain('프로젝트');
    expect(container.querySelector('[data-testid="api-keys-load-failed"]')).toBeNull();
  });
});
