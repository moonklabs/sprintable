// @vitest-environment jsdom
//
// story 4912 D5 — the header «온보딩 메시지 복사» used to be ON whenever a key was listed, and with no fresh key it copied «{key prefix}...» (a message the agent cannot use). The onboarding message needs the FULL key,
// which exists only right after issuing: so the button is ON only while a fresh key is held, and a listed key alone leaves it OFF (nothing is copied).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

const { copied, addToast } = vi.hoisted(() => ({ copied: [] as string[], addToast: () => {} }));
vi.mock('@/lib/clipboard', () => ({ copyTextSafely: async (text: string) => { copied.push(text); return { ok: true }; } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = koMessages.settings;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { copied.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const listed = { id: 'key-1', key_prefix: 'sk_live_abcd', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] };
const stubFetch = (keys: unknown[]) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (String(url).includes('/api-key') && init?.method === 'POST'
  ? new Response(JSON.stringify({ data: { api_key: 'sk_live_FRESHKEY' } }), { status: 201 })
  : String(url).includes('/api-key') ? new Response(JSON.stringify({ data: keys }), { status: 200 }) : new Response(JSON.stringify({ data: [] }), { status: 200 }))));
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const mount = async () => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); }); await settle(); };
const header = () => Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"] button')).find((b) => b.textContent?.trim() === S.agentApiKeyCopyOnboardingCta) as HTMLButtonElement | undefined;
const btn = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

describe('머리 «온보딩 메시지 복사»는 새 키가 있을 때만 켜진다(story 4912 D5)', () => {
  it('⭐a key is LISTED but none is fresh → the button is off and a click copies nothing (it used to copy «sk_live_abcd...»)', async () => {
    stubFetch([listed]);
    await mount();
    expect(document.body.textContent).toContain('sk_live_abcd'); // the listed key is on screen
    expect(header()?.disabled).toBe(true);
    await act(async () => { header()?.click(); });
    await settle();
    expect(copied.length).toBe(0);
  });

  it('no key at all → off too (unchanged)', async () => {
    stubFetch([]);
    await mount();
    expect(header()?.disabled).toBe(true);
  });

  it('⭐right after issuing a key (fresh key held) → the button is ON and copies the message with the full key', async () => {
    stubFetch([]);
    await mount();
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle();
    expect(header()?.disabled).toBe(false);
    await act(async () => { header()?.click(); });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain('sk_live_FRESHKEY');
  });
});
