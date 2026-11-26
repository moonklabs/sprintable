// @vitest-environment jsdom
//
// story 5036 — the form's wiring of the key way into step ③. The panel's own «tell the page once» is pinned in advanced-connect.test.tsx; here the panel is a stand-in
// that calls `onConnected` on a press, so what is tested is only the FORM: it moves on to ③ and opens the conversation with THAT agent in THAT project.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';

// the stand-in: shows the project it was given and tells the page that agent-9 connected when pressed
vi.mock('./advanced-connect', () => ({
  AdvancedConnect: ({ projectId, onConnected }: { projectId: string; onConnected?: (id: string) => void }) => (
    <button type="button" data-testid="stub-key-way" data-project={projectId} onClick={() => onConnected?.('agent-9')}>stub</button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { OnboardingForm } = await import('./onboarding-form');

interface Call { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[];
let container: HTMLDivElement;
let root: Root;
let hrefs: string[];
const originalLocation = window.location;

let reentry = false; // the organization already has an agent that connected through the key way before this page was opened
beforeEach(() => {
  reentry = false;
  hrefs = [];
  calls = [];
  const fake = { ...originalLocation, replace: vi.fn(), assign: vi.fn() } as Record<string, unknown>;
  Object.defineProperty(fake, 'href', { configurable: true, get: () => 'http://localhost/onboarding', set: (v: string) => { hrefs.push(v); } });
  Object.defineProperty(window, 'location', { configurable: true, value: fake });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
  _resetActivationStatusCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split('?')[0]!;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const ok = (json: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => json });
    if (path === '/api/auth/me') return ok({ data: { member_id: 'u-1', email_verified: true, org_id: 'org-1', org_member_id: 'om-1', display_name: '김지우' } });
    if (path === '/api/auth/refresh') return ok({ data: { ok: true } });
    if (path === '/api/projects' && method === 'GET') return ok({ data: [{ id: 'proj-1' }] });
    if (path === '/api/current-project' || path === '/api/onboarding/events') return ok({});
    if (path === '/api/activation/checklist') return ok({ data: { steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: false, first_roundtrip: false }, completed: 3, total: 5, all_complete: false, first_instruction_conversation_id: null } });
    if (path === '/api/conversations' && method === 'POST') return ok({ id: 'conv-9' });
    if (reentry && path === '/api/team-members' && method === 'GET') return ok({ data: [{ id: 'agent-7', name: '내 에이전트' }] });
    if (reentry && path === '/api/agents/agent-7/verification-status') return ok({ data: { verified: true, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' }, { state: 'mcp_reachable', status: 'done' }, { state: 'verified', status: 'done' }] } });
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  delete (navigator as { userAgent?: string }).userAgent;
});

const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (el: HTMLElement | null) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); }); await flush(); };

describe('[SID:5036] ③ after the key way — the form moves on and opens the conversation with THAT agent in THAT project', () => {
  it('K1 the key way connected → step ③ (the strip at 3 of 3) · [첫 지시 보내기] → a DM with agent-9 in proj-1, no guessing of «the first agent»', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    // the key way is given the project the line has (here: the organization's own)
    expect(q('stub-key-way')?.getAttribute('data-project')).toBe('proj-1');
    expect(q('onboarding-first-chat')).toBeNull(); // not before it connects
    await press(q('stub-key-way'));
    // reverted (the form ignores `onConnected`) → still step ② here
    expect(q('onboarding-first-chat')).not.toBeNull();
    expect([...container.querySelectorAll('[data-slot="ds-stepper-step"]')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'current']);
    // (step ② draws the line for an agent that connected BEFORE the page was opened — that asks the list — so the reads are counted from here: step ③ guesses nothing)
    const listReadsAtThree = calls.filter((c) => c.url.startsWith('/api/team-members')).length;
    await press(q('onboarding-first-chat-start'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/conversations')[0]!.body).toEqual({ type: 'dm', participant_ids: ['agent-9'], project_id: 'proj-1' });
    // the agent is known, so the project's agent list is not read to guess one
    expect(calls.filter((c) => c.url.startsWith('/api/team-members')).length).toBe(listReadsAtThree);
    expect(hrefs.at(-1)).toBe('/chats/conv-9?p=proj-1');
  });

  it('R1 coming back after the key way connected (a reload): step ② draws the line over the three ways · [첫 대화로] → step ③ with THAT agent, and the first instruction goes to it', async () => {
    reentry = true;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <OnboardingForm todayHref="/today" chatsHref="/chats" />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    // reverted (the line is not drawn) → a person who already connected sees only «not yet» and no way on
    expect(q('connect-branches-connected')).not.toBeNull();
    expect(q('onboarding-first-chat')).toBeNull();
    await press(q('connect-branches-connected-go'));
    expect(q('onboarding-first-chat')).not.toBeNull();
    await press(q('onboarding-first-chat-start'));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/conversations')[0]!.body).toEqual({ type: 'dm', participant_ids: ['agent-7'], project_id: 'proj-1' });
  });
});
