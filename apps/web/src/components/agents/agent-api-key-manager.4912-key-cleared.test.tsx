// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story 4912 D4 — the full key is shown once, in the «key shown» dialog. Closing that dialog by ANY way (the [완료] button, Esc) must drop the plaintext key (and the MCP config) from state:
// before, only [완료] cleared the key (and never the MCP config) — Esc / a click outside left it, so the header's «온보딩 메시지 복사» kept copying the full key.
const { copied, addToast, copyState } = vi.hoisted(() => ({ copied: [] as string[], addToast: () => {}, copyState: { ok: true, gate: null as Promise<void> | null } })); // addToast must keep ONE identity: the load effect depends on it
vi.mock('@/lib/clipboard', () => ({ copyTextSafely: async (text: string) => { copied.push(text); if (copyState.gate) await copyState.gate; return { ok: copyState.ok }; } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEW_KEY = 'sk_live_FULLKEY_should_not_survive';
const MCP = '{"mcpServers":{"sprintable":{"url":"https://example.test/mcp"}}}';
const S = koMessages.settings;

let container: HTMLDivElement;
let root: Root;

// one ACTIVE key is listed (so the header copy button is enabled with or without the fresh key): its prefix is what a copy may carry — never the full key
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api-key') && init?.method === 'POST') return new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: MCP } }), { status: 201 });
    if (String(url).includes('/api-key') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: [{ id: 'key-1', key_prefix: 'sk_live_abcd', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}
const btn = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };

// render → [API 키 발급] (a key is active, so the revoke-confirm opens first) → [무효화하고 새 키 발급] → the key shown dialog is open with the full key in it
async function openKeyShownDialog() {
  stubFetch();
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
  await settle();
  await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
  await settle();
  const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('새 키 발급') && b !== btn(S.agentApiKeyGenerate));
  expect(confirmBtn, 'the revoke-and-reissue confirm button is there').toBeTruthy();
  await act(async () => { confirmBtn?.click(); });
  await settle();
  expect(document.body.textContent).toContain(NEW_KEY); // the key IS shown while the dialog is open
}

beforeEach(() => { copied.length = 0; copyState.ok = true; copyState.gate = null; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AgentApiKeyManager — 4912 D4: the full key does not stay once the key-shown dialog is closed', () => {
  it('⭐Esc closes the dialog → the header «온보딩 메시지 복사» no longer carries the full key (only the listed key\'s prefix) — reverting the shared close path turns this red', async () => {
    await openKeyShownDialog();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(document.body.textContent).not.toContain(NEW_KEY); // dialog gone
    await act(async () => { btn(S.agentApiKeyCopyOnboardingCta)?.click(); });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0]).not.toContain(NEW_KEY);
    expect(copied[0]).not.toContain('https://example.test/mcp'); // the MCP config the create answer brought goes too
  });

  it('⭐the [완료] button clears the key AND the MCP config (before, the MCP config stayed)', async () => {
    await openKeyShownDialog();
    await act(async () => { btn(S.agentApiKeyDone)?.click(); });
    await settle();
    await act(async () => { btn(S.agentApiKeyCopyOnboardingCta)?.click(); });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0]).not.toContain(NEW_KEY);
    expect(copied[0]).not.toContain('https://example.test/mcp');
  });

  it('while the dialog is OPEN the header copy still carries the full key (the normal path is unchanged)', async () => {
    await openKeyShownDialog();
    const header = Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"] button')).find((b) => b.textContent?.trim() === S.agentApiKeyCopyOnboardingCta) as HTMLButtonElement | undefined;
    expect(header).toBeTruthy();
    await act(async () => { header?.click(); });
    await settle();
    expect(copied.some((c) => c.includes(NEW_KEY))).toBe(true);
  });
});

describe('AgentApiKeyManager — 4912 D4: the other things that could hold the key, and a late answer', () => {
  it('⭐a failed onboarding copy leaves the whole message (with the key) in a textarea — closing the dialog removes it', async () => {
    await openKeyShownDialog();
    copyState.ok = false;
    const header = Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"] button')).find((b) => b.textContent?.trim() === S.agentApiKeyCopyOnboardingCta) as HTMLButtonElement | undefined;
    await act(async () => { header?.click(); });
    await settle();
    expect(Array.from(document.querySelectorAll('textarea')).some((t) => t.value.includes(NEW_KEY))).toBe(true); // the failed copy shows the message
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(Array.from(document.querySelectorAll('textarea')).some((t) => t.value.includes(NEW_KEY))).toBe(false);
  });

  it('⭐the dialog closed while the key request was still out → the late answer is NOT dropped (the old key is already revoked): the dialog opens and shows the key; closing it clears it again', async () => {
    let answerPost!: (r: Response) => void;
    const postGate = new Promise<Response>((res) => { answerPost = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api-key') && init?.method === 'POST') return postGate;
      if (String(url).includes('/api-key') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'key-1', key_prefix: 'sk_live_abcd', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
    await settle();
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle();
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('새 키 발급') && b !== btn(S.agentApiKeyGenerate));
    await act(async () => { confirmBtn?.click(); });
    await settle(); // the key dialog is open, the POST is still out
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle(); // closed before the answer
    expect(document.body.textContent).not.toContain(NEW_KEY);
    await act(async () => { answerPost(new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: MCP } }), { status: 201 })); });
    await settle();
    expect(document.body.textContent).toContain(NEW_KEY); // opened again to show it once
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(document.body.textContent).not.toContain(NEW_KEY);
    await act(async () => { btn(S.agentApiKeyCopyOnboardingCta)?.click(); });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0]).not.toContain(NEW_KEY); // and nothing of it stays in state with the dialog shut
  });

  it('the dialog\'s own X (the primitive close button) clears it the same way', async () => {
    await openKeyShownDialog();
    const x = document.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement | null;
    expect(x, 'the dialog has its own close button').toBeTruthy();
    await act(async () => { x?.click(); });
    await settle();
    await act(async () => { btn(S.agentApiKeyCopyOnboardingCta)?.click(); });
    await settle();
    expect(copied[0]).not.toContain(NEW_KEY);
  });

  it('⭐a copy still pending when the dialog is closed, then FAILING, does not bring the message (with the key) back — no textarea, nothing in state (codex round 2)', async () => {
    await openKeyShownDialog();
    let failCopy!: () => void;
    copyState.gate = new Promise<void>((res) => { failCopy = res; });
    copyState.ok = false;
    const header = Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"] button')).find((b) => b.textContent?.trim() === S.agentApiKeyCopyOnboardingCta) as HTMLButtonElement | undefined;
    await act(async () => { header?.click(); });
    await settle(); // the copy is out
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle(); // dialog closed while it is out
    await act(async () => { failCopy(); });
    await settle(); // it fails after the close
    expect(Array.from(document.querySelectorAll('textarea')).some((t) => t.value.includes(NEW_KEY))).toBe(false);
    expect(document.body.textContent).not.toContain(NEW_KEY);
  });
});
