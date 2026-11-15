// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { MessagingPolicySection } from './messaging-policy-section';

// story 4912 (PO 11-13) — a REJECTED request (the network went away, or the answer cannot be read) said nothing on this card: the mode save, the add and the remove only spoke for an HTTP error answer.
// Now the same error toast speaks, and the control comes back (`savingMode` / `pendingId` freed).
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = koMessages.settings;
let container: HTMLDivElement;
let root: Root;
let mode: 'creator_only' | 'list';
let failWrites: 'reject' | 'unreadable';

beforeEach(() => {
  addToast.mockClear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  mode = 'creator_only'; failWrites = 'reject';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/agents/agent-1/message-policy' && method === 'GET') return { ok: true, json: async () => ({ data: { mode, allowlist: mode === 'list' ? ['m-1'] : [] } }) };
    if (url === '/api/agents/agent-1/message-policy/candidates') return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-9', name: '멤버 하나' }, { id: 'm-2', user_id: 'u-8', name: '멤버 둘' }] }) };
    if (method !== 'GET' && failWrites === 'reject') throw new TypeError('network down');
    if (method !== 'GET') return { ok: true, json: async () => { throw new SyntaxError('unreadable'); } };
    return { ok: true, json: async () => ({ data: {} }) };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><MessagingPolicySection agentId="agent-1" creatorUserId="u-1" /></NextIntlClientProvider>); });
  await flush(); await flush();
}
const card = () => container.querySelector('[data-testid="agent-detail-card-messaging-policy"]') as HTMLElement;
const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
const saveBtn = () => [...card().querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save || b.textContent === '...') as HTMLButtonElement | undefined;

describe('MessagingPolicySection — 4912: a rejected request says so', () => {
  it('⭐모드 저장이 거절되면(네트워크) «저장하지 못했어요» 토스트 · [저장]이 다시 눌린다 — catch를 걷으면 RED', async () => {
    await mount();
    await act(async () => { radios()[2]!.click(); });
    await act(async () => { saveBtn()!.click(); });
    await flush();
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: S.messagingPolicySaveError });
    expect(saveBtn()!.disabled).toBe(false);
    expect(saveBtn()!.textContent).toBe(koMessages.common.save); // not stuck on «...»
  });

  it('⭐구성원 빼기가 거절돼도 오류 토스트 · 그 줄의 빼기 단추가 다시 눌린다', async () => {
    mode = 'list';
    await mount();
    const remove = card().querySelector(`button[aria-label="${koMessages.common.delete} · 멤버 하나"]`) as HTMLButtonElement;
    await act(async () => { remove.click(); });
    await flush();
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: koMessages.common.error });
    expect((card().querySelector(`button[aria-label="${koMessages.common.delete} · 멤버 하나"]`) as HTMLButtonElement).disabled).toBe(false);
  });

  it('⭐구성원 추가가 거절돼도 · 답을 못 읽어도 오류 토스트(전엔 처리 안 된 거절)', async () => {
    mode = 'list';
    await mount();
    const openPicker = () => [...card().querySelectorAll('button')].find((b) => b.textContent?.includes('구성원 추가')) as HTMLButtonElement;
    await act(async () => { openPicker().click(); });
    await flush();
    const row = () => card().querySelector('[data-row-name]') as HTMLElement;
    await act(async () => { (row().closest('button') ?? row()).click(); });
    await flush();
    expect(addToast).toHaveBeenLastCalledWith({ type: 'error', title: koMessages.common.error });
    addToast.mockClear();
    failWrites = 'unreadable';
    await act(async () => { (row().closest('button') ?? row()).click(); });
    await flush();
    expect(addToast).toHaveBeenLastCalledWith({ type: 'error', title: koMessages.common.error });
  });
});
