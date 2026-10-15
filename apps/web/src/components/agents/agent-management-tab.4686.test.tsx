// @vitest-environment jsdom
//
// story 4686 (AC3 · Yuna run-info-1014 (4)) — the org agent list says «모델 · 런타임 기본값» on a desktop agent whose run profile names no
// model (the list read's `run_model_unset: true`): a neutral badge, the run settings screen's own word. false / null / absent → none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { AgentManagementTab } from './agent-management-tab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(agents: object[], locale: 'ko' | 'en' = 'ko') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) return { ok: true, json: async () => ({ data: agents }) };
    return { ok: false, json: async () => null };
  }));
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const cards = () => [...container.querySelectorAll('a[href$="/organization/workforce/a1"], a[href$="/organization/workforce/a2"], a[href$="/organization/workforce/a3"], a[href$="/organization/workforce/a4"]')]
  .filter((a) => a.classList.contains('flex-1'));

describe('[SID:4686] AgentManagementTab — «모델 · 런타임 기본값» on an agent that names no model', () => {
  it('run_model_unset true → the badge on that card only; false · null · absent → none', async () => {
    await mount([
      { id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code', run_model_unset: true },
      { id: 'a2', name: '작성', role: 'member', is_active: true, runtime_type: 'claude-code', run_model_unset: false },
      { id: 'a3', name: '검수', role: 'member', is_active: true, runtime_type: 'hermes', run_model_unset: null },
      { id: 'a4', name: '번역', role: 'member', is_active: true, runtime_type: 'codex' }, // an older server: the field is absent
    ]);
    const text = (container.textContent ?? '').split('모델 · 런타임 기본값');
    expect(text.length - 1).toBe(1); // exactly one badge in the whole list
    const marked = cards().filter((c) => c.textContent?.includes('모델 · 런타임 기본값'));
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('조사');
  });

  it('English: «Model · Runtime default»', async () => {
    await mount([{ id: 'a1', name: 'Scout', role: 'member', is_active: true, runtime_type: 'claude-code', run_model_unset: true }], 'en');
    expect(container.textContent).toContain('Model · Runtime default');
  });
});
