// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story 4912 D4 — the full key is shown once, in the «key shown» dialog. Closing that dialog by ANY way (the [완료] button, Esc) must drop the plaintext key (and the MCP config) from state:
// before, only [완료] cleared the key (and never the MCP config) — Esc / a click outside left it, so the header's «온보딩 메시지 복사» kept copying the full key.
const { copied, addToast, toasts, copyState } = vi.hoisted(() => { const toasts: Array<{ body?: string }> = []; return { copied: [] as string[], toasts, addToast: (t: { body?: string }) => { toasts.push(t); }, copyState: { ok: true, gate: null as Promise<void> | null } }; }); // addToast must keep ONE identity: the load effect depends on it
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
// after the dialog is closed no fresh key is held: the header «온보딩 메시지 복사» is OFF (story 4912 D5), a click copies nothing — and never the full key (D4)
const headerBtn = () => Array.from(document.querySelectorAll('[data-testid="agent-api-key-manager"] button')).find((b) => b.textContent?.trim() === S.agentApiKeyCopyOnboardingCta) as HTMLButtonElement | undefined;
async function expectHeaderCopyOffAndNothingCopied() {
  expect(headerBtn()?.disabled).toBe(true);
  await act(async () => { headerBtn()?.click(); });
  await settle();
  expect(copied.length).toBe(0);
  expect(copied.some((c) => c.includes(NEW_KEY))).toBe(false);
}

// render → [API 키 발급] (a key is active, so the revoke-confirm opens first) → [무효화하고 새 키 발급] → the key shown dialog is open with the full key in it
async function openKeyShownDialog() {
  stubFetch();
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
  await settle();
  await act(async () => { btn(S.agentApiKeyReplaceCta)?.click(); });
  await settle();
  const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('새 키 발급') && b !== btn(S.agentApiKeyReplaceCta));
  expect(confirmBtn, 'the revoke-and-reissue confirm button is there').toBeTruthy();
  await act(async () => { confirmBtn?.click(); });
  await settle();
  expect(document.body.textContent).toContain(NEW_KEY); // the key IS shown while the dialog is open
}

beforeEach(() => { toasts.length = 0; copied.length = 0; copyState.ok = true; copyState.gate = null; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AgentApiKeyManager — 4912 D4: the full key does not stay once the key-shown dialog is closed', () => {
  it('⭐Esc closes the dialog → the header «온보딩 메시지 복사» no longer carries the full key (only the listed key\'s prefix) — reverting the shared close path turns this red', async () => {
    await openKeyShownDialog();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(document.body.textContent).not.toContain(NEW_KEY); // dialog gone
    await expectHeaderCopyOffAndNothingCopied();
  });

  it('⭐the [완료] button clears the key AND the MCP config (before, the MCP config stayed)', async () => {
    await openKeyShownDialog();
    await act(async () => { btn(S.agentApiKeyDone)?.click(); });
    await settle();
    await expectHeaderCopyOffAndNothingCopied();
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
    await act(async () => { btn(S.agentApiKeyReplaceCta)?.click(); });
    await settle();
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('새 키 발급') && b !== btn(S.agentApiKeyReplaceCta));
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
    await expectHeaderCopyOffAndNothingCopied();
  });

  it('the dialog\'s own X (the primitive close button) clears it the same way', async () => {
    await openKeyShownDialog();
    const x = document.querySelector(`[data-slot="ds-dialog-content"] button[aria-label="${koMessages.common.close}"]`) as HTMLButtonElement | null; // the ds Dialog's own close (X)
    expect(x, 'the dialog has its own close button').toBeTruthy();
    await act(async () => { x?.click(); });
    await settle();
    await expectHeaderCopyOffAndNothingCopied();
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

  it('⭐읽기에 성공할 때마다 «활성 키 몇 개»를 알린다(상세 옆 칸이 쓴다) — 폐기한 키는 세지 않고, 읽기가 실패하면 알리지 않는다', async () => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api-key')
      ? new Response(JSON.stringify({ data: [
        { id: 'k1', key_prefix: 'sk_live_a', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] },
        { id: 'k2', key_prefix: 'sk_live_b', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: '2026-08-02T00:00:00Z', expires_at: null, scope: ['stories'] },
      ] }), { status: 200 })
      : new Response('{}', { status: 404 }))));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onKeysRead={(n) => calls.push(n)} /></NextIntlClientProvider>); });
    await settle();
    expect(calls).toEqual([1]); // one active, one revoked
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await act(async () => { btn(S.agentApiKeyRefresh)?.click(); });
    await settle();
    expect(calls).toEqual([1]); // the failed read said nothing
  });

  it('⭐단추는 하는 일 그대로의 이름이다 — 키가 있으면 «새 키로 바꾸기»(누르면 무효화 확인), 키가 없으면 «API 키 발급»', async () => {
    stubFetch(); // one active key is listed
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
    await settle();
    expect(btn(S.agentApiKeyReplaceCta)).toBeTruthy();
    expect(btn(S.agentApiKeyGenerate)).toBeUndefined();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
    await settle();
    expect(btn(S.agentApiKeyGenerate)).toBeTruthy();
    expect(btn(S.agentApiKeyReplaceCta)).toBeUndefined();
  });

  it('⭐compact: 패널 안에서는 카드가 자기 제목 · 설명을 그리지 않는다(패널 제목이 에이전트 이름) — 단추는 그대로', async () => {
    stubFetch();
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" compact /></NextIntlClientProvider>); });
    await settle();
    expect(container.querySelector('h3')).toBeNull();
    expect(container.textContent).not.toContain(S.agentApiKeyListDescription);
    expect(btn(S.agentApiKeyReplaceCta)).toBeTruthy();
  });

  it('⭐onIssuingChange: 새 키를 만드는 동안 true(바꾸기는 옛 키를 무효화하는 순간부터) · 답이 오면 false · 만들기가 실패해도 false(패널이 영영 안 닫히지 않게)', async () => {
    const calls: boolean[] = [];
    let answer!: (r: Response) => void;
    const postGate = new Promise<Response>((res) => { answer = res; });
    let finishRevoke!: () => void;
    const deleteGate = new Promise<void>((res) => { finishRevoke = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api-key') && init?.method === 'POST') return postGate;
      if (u.includes('/api-key') && init?.method === 'DELETE') { await deleteGate; return new Response('{}', { status: 200 }); }
      if (u.includes('/api-key')) return new Response(JSON.stringify({ data: [{ id: 'key-1', key_prefix: 'sk_live_abcd', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
    await settle();
    expect(calls).toEqual([]);
    await act(async () => { btn(S.agentApiKeyReplaceCta)?.click(); });
    await settle();
    expect(calls).toEqual([]); // the confirm is only asked — nothing is revoked yet
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('새 키 발급') && b !== btn(S.agentApiKeyReplaceCta));
    await act(async () => { confirmBtn?.click(); });
    await settle();
    expect(calls).toEqual([true]); // the old key is being revoked (the DELETE is still out): the panel must already stay
    await act(async () => { finishRevoke(); });
    await settle();
    expect(calls.at(-1)).toBe(true); // the create answer is still out
    await act(async () => { answer(new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: MCP } }), { status: 201 })); });
    await settle();
    expect(calls.at(-1)).toBe(false);
    // a FAILED create ends it too
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (String(url).includes('/api-key') && init?.method === 'POST' ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ data: [] }), { status: 200 }))));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
    await settle();
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle();
    expect(calls).toEqual([true, false]);
  });

  it('⭐«발급 중»은 키가 상태에 적힌 순간 끝난다 — 뒤따르는 키 목록 읽기가 끝나기를 기다리지 않는다(패널이 그 읽기에 묶이지 않게)', async () => {
    const calls: boolean[] = [];
    let listGets = 0;
    let finishList!: (r: Response) => void;
    const listGate = new Promise<Response>((res) => { finishList = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api-key') && init?.method === 'POST') return new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: MCP } }), { status: 201 });
      if (u.includes('/api-key')) { listGets += 1; return listGets === 1 ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : listGate; } // the follow-up read (2nd GET) hangs
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
    await settle();
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle();
    expect(document.body.textContent).toContain(NEW_KEY); // the key is in the dialog
    expect(calls.at(-1), 'ended at the state write, the follow-up read is still out').toBe(false);
    await act(async () => { finishList(new Response(JSON.stringify({ data: [] }), { status: 200 })); });
    await settle();
  });

  it('⭐만들기 답의 본문이 끝나지 않으면 20초 뒤 «발급 실패»로 끝난다 — «발급 중»이 영영 안 풀려 패널이 새로고침 전까지 안 닫히지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const calls: boolean[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api-key') && init?.method === 'POST') return { ok: true, status: 201, json: () => new Promise(() => {}) } as unknown as Response; // headers came, the body never ends
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }));
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
      await settle();
      await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
      await settle();
      expect(calls.at(-1), 'still issuing while the body is awaited').toBe(true);
      await act(async () => { vi.advanceTimersByTime(20_001); });
      await settle();
      expect(calls.at(-1), 'the bounded read ended it').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐옛 카드의 뒤늦은 «발급 중 끝»이 새 패널의 «발급 중»을 지우지 않는다(codex) — 카드 A가 키를 적고 닫힌 뒤 뒤따르는 읽기가 끝나도, 그 사이 새 카드 B가 잡은 hold는 그대로', async () => {
    const calls: boolean[] = [];
    let finishListA!: (r: Response) => void;
    const listGateA = new Promise<Response>((res) => { finishListA = res; });
    let aListGets = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const isA = u.includes('/agent-1/');
      if (u.includes('/api-key') && init?.method === 'POST') return isA ? new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: MCP } }), { status: 201 }) : new Promise<Response>(() => {}); // B's create never answers (it stays «발급 중»)
      if (u.includes('/api-key')) { if (isA) { aListGets += 1; if (aListGets > 1) return listGateA; } return new Response(JSON.stringify({ data: [] }), { status: 200 }); }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const mountCard = async (agentId: string) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId={agentId} agentName={agentId} onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); }); await settle(); };
    await mountCard('agent-1');
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle(); // A wrote the key (hold released) and its follow-up list read is out
    expect(calls).toEqual([true, false]);
    await act(async () => { root.unmount(); }); // the panel closes: card A is gone while its read is still out
    root = createRoot(container);
    await mountCard('agent-2');
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle(); // B took the hold
    expect(calls.at(-1)).toBe(true);
    await act(async () => { finishListA(new Response(JSON.stringify({ data: [] }), { status: 200 })); });
    await settle(); // A's late read ends: it must NOT release B's hold
    expect(calls.at(-1), 'B still holds the panel').toBe(true);
  });

  it('⭐hold를 쥔 채 카드가 사라지면(목록이 바뀌어 에이전트가 빠짐 등) 그 hold를 놓는다 — 패널이 영영 못 닫히지 않게', async () => {
    const calls: boolean[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (String(url).includes('/api-key') && init?.method === 'POST' ? new Promise<Response>(() => {}) : new Response(JSON.stringify({ data: [] }), { status: 200 }))));
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="a" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
    await settle();
    await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
    await settle();
    expect(calls).toEqual([true]);
    await act(async () => { root.unmount(); });
    expect(calls).toEqual([true, false]);
    root = createRoot(container);
  });

  it('⭐만들기 답의 본문이 끝나지 않아 시간이 다 되면 «발급 실패»가 아니라 «새 키가 만들어졌을 수 있어요»라 말하고 키 목록을 다시 읽는다(옛 키는 이미 무효 — codex)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let listGets = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api-key') && init?.method === 'POST') return { ok: true, status: 201, json: () => new Promise(() => {}) } as unknown as Response;
        if (u.includes('/api-key')) { listGets += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }); }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }));
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="a" /></NextIntlClientProvider>); });
      await settle();
      const before = listGets;
      await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
      await settle();
      await act(async () => { vi.advanceTimersByTime(20_001); });
      await settle();
      expect(toasts.map((t) => t.body)).toContain(S.agentApiKeyCreateUnconfirmed);
      expect(toasts.map((t) => t.body)).not.toContain(S.agentApiKeyGenerateFailed);
      expect(listGets, 'the list is read again so what exists is on screen').toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐본문 시간 초과 뒤 키 목록 읽기가 멈춰도 패널은 잡히지 않는다 — «발급 중»은 만들기가 끝난 순간 풀리고 목록 읽기를 기다리지 않는다(codex 2차)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const calls: boolean[] = [];
      let listGets = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api-key') && init?.method === 'POST') return { ok: true, status: 201, json: () => new Promise(() => {}) } as unknown as Response;
        if (u.includes('/api-key')) { listGets += 1; return listGets === 1 ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : new Promise<Response>(() => {}); } // the re-read after the timeout hangs
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }));
      await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="a" onIssuingChange={(b) => calls.push(b)} /></NextIntlClientProvider>); });
      await settle();
      await act(async () => { btn(S.agentApiKeyGenerate)?.click(); });
      await settle();
      await act(async () => { vi.advanceTimersByTime(20_001); });
      await settle();
      expect(listGets).toBeGreaterThan(1); // the re-read is out and never answers
      expect(calls.at(-1), 'the panel is free although the list read is stuck').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

