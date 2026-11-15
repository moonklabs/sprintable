// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ChatInput } from './chat-input';
import { invalidateOrgDomainLabels } from '@/hooks/use-org-domain-labels';

// story 4920 (the owner's report 11-13: «스토리 선택 안하면 메시지 전송조차 안되는지?») — a direction instruction is «to whom · what»: the target and the text.
// The work item is context that may ride along; it was a hard requirement (Enter did nothing, the send button stayed off, nothing said why).
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C = koMessages.chats;
const PARTICIPANTS = [{ member_id: 'me', name: '나' }, { member_id: 'u1', name: '동료1' }];

let container: HTMLDivElement;
let root: Root;
let published: Array<Record<string, unknown>>;

function withIntl(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}
function stubStore() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
}
function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
const targetSelect = () => container.querySelector('select') as HTMLSelectElement;
const sendBtn = () => container.querySelector('[data-testid="chat-send"]') as HTMLButtonElement;
const toggle = () => [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === C.steerToggleLabel) as HTMLButtonElement;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };

async function openSteer() {
  await act(async () => { root.render(withIntl(<ChatInput threadId="c1" onSend={vi.fn()} currentTeamMemberId="me" participants={PARTICIPANTS} projectId="p1" />)); });
  await act(async () => { toggle().click(); });
}

beforeEach(() => {
  invalidateOrgDomainLabels();
  stubStore();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  published = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/events/publish' && init?.method === 'POST') { published.push(JSON.parse(init.body ?? '{}')); return new Response(JSON.stringify({ data: { id: 'm1' } }), { status: 201 }); }
    return new Response(JSON.stringify({ data: [] }));
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ChatInput STEER — the work item is optional (story 4920)', () => {
  it('⭐target + instruction, NO work item → the button is on and the click sends it: the payload carries no work_item_* — reverting the required check turns this red', async () => {
    await openSteer();
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    await act(async () => { setValue(targetSelect(), 'u1'); });
    expect(sendBtn().disabled).toBe(false);
    await act(async () => { sendBtn().click(); });
    await settle();
    expect(published).toEqual([{ definition_key: 'preset.steer.instruct', conversation_id: 'c1', payload: { target_member_id: 'u1', instruction: '이제 A로 가자' } }]);
    expect(Object.keys((published[0].payload as Record<string, unknown>))).not.toContain('work_item_id');
    expect(container.textContent).not.toContain(C.steerPanelTitle); // sent → the panel closes, as before
  });

  it('⭐Enter sends it too (desktop)', async () => {
    await openSteer();
    await act(async () => { setValue(textarea(), '지금 바로 시작해 줘'); });
    await act(async () => { setValue(targetSelect(), 'u1'); });
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(published).toHaveLength(1);
    expect((published[0].payload as Record<string, unknown>).target_member_id).toBe('u1');
  });

  it('⭐instruction typed but nobody chosen → the button is off AND a line says why (a status, next to the composer); choosing the target clears it and turns the button on', async () => {
    await openSteer();
    expect(container.querySelector('[data-testid="steer-need-target"]')).toBeNull(); // nothing typed yet: no nagging
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    expect(sendBtn().disabled).toBe(true);
    const hint = container.querySelector('[data-testid="steer-need-target"]');
    expect(hint?.textContent).toBe(C.steerNeedTarget);
    expect(hint?.getAttribute('role')).toBe('status');
    await act(async () => { setValue(targetSelect(), 'u1'); });
    expect(container.querySelector('[data-testid="steer-need-target"]')).toBeNull();
    expect(sendBtn().disabled).toBe(false);
  });

  it('⭐Enter with no target does NOT stay silent: an alert says why, nothing is sent; choosing a target clears the alert', async () => {
    await openSteer();
    await act(async () => { setValue(textarea(), '이제 A로 가자'); });
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(published).toHaveLength(0);
    const alert = [...container.querySelectorAll('[role="alert"]')].find((e) => e.textContent === C.steerNeedTarget);
    expect(alert, 'the reason is said out loud').toBeTruthy();
    expect(container.querySelector('[data-testid="steer-need-target"]'), 'the same sentence is not on the page twice').toBeNull();
    await act(async () => { setValue(targetSelect(), 'u1'); });
    expect([...container.querySelectorAll('[role="alert"]')].some((e) => e.textContent === C.steerNeedTarget)).toBe(false);
  });

  it('Enter on an empty instruction stays a plain no-op (as the normal send)', async () => {
    await openSteer();
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(published).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('the work-item field says it is optional (both languages)', async () => {
    await openSteer();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('대상 작업(선택)');
    expect(input.getAttribute('placeholder')).toContain('(선택)');
    expect(enMessages.chats.steerPanelWorkItemLabel).toContain('(optional)');
    expect(enMessages.chats.steerPanelWorkItemPlaceholder).toContain('(optional)');
    expect(enMessages.chats.steerNeedTarget.length).toBeGreaterThan(0);
  });
});
