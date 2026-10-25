// @vitest-environment jsdom
//
// story 4780 (AC4) — the checklist finishes and the person gets to see it finish: a browser that showed an OPEN checklist for the organization says «다 됐어요» once when it is complete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ACTIVATION_DONE_LINE_MS, ActivationChecklistBanner } from './activation-checklist-banner';
import { ACTIVATION_REFRESH_MS, _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';

const mockOrg = { orgId: 'org-1' };
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    projectId: 'proj-1', orgId: mockOrg.orgId, activationOrgId: mockOrg.orgId, activationSeedFromHint: false,
    initialActivationComplete: undefined, initialActivationCollapsed: undefined,
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/today' }));
vi.mock('@/lib/onboarding/first-instruction', () => ({ createFirstInstructionConversation: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEEN = (org: string) => `sprintable_activation_seen_open:${org}`;

let localStore: Map<string, string>;
let refuse = false; // localStorage refused (private window · blocked) — the session store keeps working (other code of the page reads it unguarded)
function stubStorages() {
  localStore = new Map<string, string>();
  const make = (store: Map<string, string>) => ({
    getItem: (k: string) => { if (refuse) throw new Error('denied'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (refuse) throw new Error('denied'); store.set(k, v); },
    removeItem: (k: string) => { if (refuse) throw new Error('denied'); store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('localStorage', make(localStore));
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  refuse = false;
  stubStorages();
  _resetActivationStatusCacheForTests();
  mockOrg.orgId = 'org-1';
  document.cookie = 'sp_activation_hint=; Path=/; Max-Age=0';
  document.cookie = 'sp_activation_collapsed=; Path=/; Max-Age=0';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const wrap = () => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ActivationChecklistBanner /></NextIntlClientProvider>
);
const done = () => container.querySelector('[data-testid="activation-done"]');
const PARTIAL = {
  steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: false },
  completed: 4, total: 5, all_complete: false, first_instruction_conversation_id: null,
};
const COMPLETE = { ...PARTIAL, steps: { ...PARTIAL.steps, first_roundtrip: true }, completed: 5, all_complete: true };
const answers = (...list: Array<Record<string, unknown>>) => {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: list[Math.min(i++, list.length - 1)] }) })));
};

describe('[SID:4780] ActivationChecklistBanner — the finish is shown once', () => {
  it('the open checklist is on screen, then it completes while the person is looking → «다 됐어요» for a while, then nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    answers(PARTIAL, COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(container.textContent).toContain('4/5단계 완료');
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // the open checklist was shown here
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(container.textContent).not.toContain('단계 완료'); // the checklist itself is gone, as before
    expect(done()?.textContent).toContain(koMessages.activation.doneTitle); // reverted (no line) → null
    expect(done()?.textContent).toContain(koMessages.activation.doneBody);
    expect(localStore.has(SEEN('org-1'))).toBe(false); // once
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_DONE_LINE_MS); });
    expect(done()).toBeNull();
  });

  it('a browser that showed it open earlier, back after the reply: the line is there on the first sight of «complete» — and not again on the next mount', async () => {
    localStore.set(SEEN('org-1'), '1');
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // the mark went with the first showing
  });

  it('a browser that never showed it open (a new device · a long-finished account): nothing, as before', async () => {
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull(); // reverted (the line for every complete) → shown here
    expect(container.textContent).toBe('');
  });

  it('the mark is per organization: org-1\'s mark does not show the line for org-2', async () => {
    localStore.set(SEEN('org-1'), '1');
    mockOrg.orgId = 'org-2';
    answers(COMPLETE);
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(done()).toBeNull();
    expect(localStore.get(SEEN('org-1'))).toBe('1'); // and org-1's own mark is still there for org-1
  });

  it('an answer that judged another organization leaves no mark', async () => {
    answers({ ...PARTIAL, scope_is_requested_org: false });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(localStore.has(SEEN('org-1'))).toBe(false);
  });

  it('storage refused (private window · blocked): nothing is thrown, nothing is shown, the checklist still draws', async () => {
    refuse = true;
    answers(PARTIAL, COMPLETE);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await act(async () => { root.render(wrap()); });
    await flush();
    expect(container.textContent).toContain('4/5단계 완료');
    await act(async () => { vi.advanceTimersByTime(ACTIVATION_REFRESH_MS); });
    await flush();
    expect(done()).toBeNull();
  });
});
