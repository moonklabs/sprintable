// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · AC2) — the new-conversation modal names each agent's computer (the chip from the same
// `/api/team-members?type=agent` read that says «연결 안 됨»): two agents with one name are told apart; the chip stands before
// the «연결 안 됨» badge (Yuna §I); no computer → no chip; a human never gets one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const MEMBERS = [
  { id: 'm-yuna', name: '유나', type: 'human' },
  { id: 'a-one', name: '조사', type: 'agent', runtime_type: 'claude-code' },
  { id: 'a-two', name: '조사', type: 'agent', runtime_type: 'codex' },
  { id: 'a-none', name: '작성', type: 'agent', runtime_type: 'claude-code' },
];
const FACTS = [
  { id: 'a-one', verified: true, device_name: 'yoonjae의 맥' },
  { id: 'a-two', verified: false, device_name: '스튜디오 맥' },
  { id: 'a-none', verified: true, device_name: null },
];

async function mount() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
    if (url.startsWith('/api/team-members?type=agent')) return { ok: true, json: async () => ({ data: FACTS }) };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NewConversationModal projectId="proj-1" onClose={() => {}} onCreated={() => {}} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const rowOf = (name: string, nth = 0) => [...document.body.querySelectorAll('li > button')].filter((b) => b.textContent?.includes(name))[nth] as HTMLElement;

describe('[SID:4675] NewConversationModal — the computer chip', () => {
  it('two agents named alike carry different chips · the chip comes before the «연결 안 됨» badge · no computer → no chip · a human none', async () => {
    await mount();
    const one = rowOf('조사', 0);
    const two = rowOf('조사', 1);
    expect(one.querySelector('[data-testid=device-chip]')?.textContent).toBe('yoonjae의 맥'); // reverted → undefined
    expect(two.querySelector('[data-testid=device-chip]')?.textContent).toBe('스튜디오 맥');
    // the chip before the badge in the row (the one thing that tells the two apart)
    const chipIdx = [...two.children].findIndex((el) => el.getAttribute('data-testid') === 'device-chip');
    const badgeIdx = [...two.children].findIndex((el) => el.textContent === koMessages.agents.agentNotConnected);
    expect(chipIdx).toBeGreaterThan(-1);
    expect(badgeIdx).toBeGreaterThan(chipIdx);
    expect(rowOf('작성').querySelector('[data-testid=device-chip]')).toBeNull();
    expect(rowOf('유나').querySelector('[data-testid=device-chip]')).toBeNull();
  });
});
