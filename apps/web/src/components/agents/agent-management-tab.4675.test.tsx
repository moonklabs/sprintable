// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · AC2) — the workforce list card ends its chip line with the agent's computer (from the list read's
// `device_name`); an agent with none has no chip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentManagementTab } from './agent-management-tab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(agents: object[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) return { ok: true, json: async () => ({ data: agents }) };
    return { ok: false, json: async () => null };
  }));
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('[SID:4675] AgentManagementTab — the computer chip on the card', () => {
  it('device_name → the chip in the card · null → none', async () => {
    await mount([
      { id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code', device_name: 'yoonjae의 맥' },
      { id: 'a2', name: '조사', role: 'member', is_active: true, runtime_type: 'codex', device_name: '스튜디오 맥' },
      { id: 'a3', name: '작성', role: 'member', is_active: true, runtime_type: 'claude-code', device_name: null },
    ]);
    const chips = [...container.querySelectorAll('[data-testid=device-chip]')].map((c) => c.textContent);
    expect(chips).toEqual(['yoonjae의 맥', '스튜디오 맥']); // reverted → []
  });
});
