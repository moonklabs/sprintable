// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story 4912 (C4) — the three windows of the key manager (replace-all confirm · single revoke confirm · the one-time «key shown» window) are ds windows now (ds ConfirmDialog / Dialog on the surface-raised face),
// so no old cream window opens on top of the new key tab (PO 11-13). Behaviour untouched: the same calls, the same texts, the key still shown once.
const { addToast } = vi.hoisted(() => ({ addToast: () => {} }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = koMessages.settings;
const NEW_KEY = 'sk_live_NEWKEY_for_the_window';
const calls: { url: string; method: string }[] = [];
let container: HTMLDivElement;
let root: Root;

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method });
    if (String(url).includes('/api-key') && method === 'POST') return new Response(JSON.stringify({ data: { api_key: NEW_KEY, mcp_config: '{}' } }), { status: 201 });
    if (String(url).includes('/api-key') && method === 'DELETE') return new Response('{}', { status: 200 });
    if (String(url).includes('/api-key')) return new Response(JSON.stringify({ data: [{ id: 'key-1', key_prefix: 'sk_live_abcd', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['stories'] }] }), { status: 200 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}
const btn = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const popup = () => document.querySelector('[data-slot="ds-dialog-content"]') as HTMLElement | null;

async function mount() {
  stubFetch();
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" /></NextIntlClientProvider>); });
  await settle();
}

beforeEach(() => { calls.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AgentApiKeyManager — 4912 C4: the windows on the ds Dialog', () => {
  it('⭐«기존 키 무효화 후 새 키 발급» 확인 = ds ConfirmDialog(위험) — 처음 초점은 «취소» · 확인은 danger 단추 · 옛 창 면이 아니다 · 누르면 새 키 창이 ds 창으로 뜬다', async () => {
    await mount();
    await act(async () => { btn(S.agentApiKeyReplaceCta)?.click(); });
    await settle();
    const dlg = popup()!;
    expect(dlg, 'a ds window').not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-content"]'), 'no old window').toBeNull();
    expect(dlg.textContent).toContain(S.agentApiKeyRevokeDialogTitle);
    const buttons = Array.from(dlg.querySelectorAll('[data-slot="ds-dialog-footer"] button')) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual([koMessages.common.cancel, S.agentApiKeyRevokeConfirmCta]); // cancel first (Base UI's first focus), then the confirm
    expect(buttons[1]!.className).toContain('border-ds-failed');
    expect(document.activeElement, 'the first focus is «취소» (Enter once must not revoke — codex)').toBe(buttons[0]);
    await act(async () => { buttons[1]!.click(); });
    await settle();
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    expect(popup()!.textContent).toContain(NEW_KEY); // the one-time key window is a ds window
  });

  it('⭐키 줄의 «키 무효화» 확인 = ds ConfirmDialog(위험) — 확인하면 그 키만 DELETE', async () => {
    await mount();
    await act(async () => { btn(S.agentApiKeySingleRevokeConfirmCta)?.click(); }); // the row's own button
    await settle();
    const dlg = popup()!;
    expect(dlg.textContent).toContain(S.agentApiKeySingleRevokeDialogTitle);
    const confirm = Array.from(dlg.querySelectorAll('[data-slot="ds-dialog-footer"] button')).find((b) => b.textContent === S.agentApiKeySingleRevokeConfirmCta) as HTMLButtonElement;
    expect(confirm.className).toContain('border-ds-failed');
    await act(async () => { confirm.click(); });
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/agents/agent-1/api-key/key-1']);
    expect(popup(), 'the confirm closed itself (the caller closes: revokeKeyId is cleared before the request)').toBeNull();
  });

  it('⭐한 번만 보이는 «새 키» 창 = ds Dialog — 이름(aria-labelledby)이 제목 · 키 칸 ds Input(읽기 전용) · 머리말 · 범위 · 온보딩 글이 sunk 면 · [완료] primary', async () => {
    await mount();
    await act(async () => { btn(S.agentApiKeyReplaceCta)?.click(); });
    await settle();
    await act(async () => { Array.from(popup()!.querySelectorAll('button')).find((b) => b.textContent === S.agentApiKeyRevokeConfirmCta)!.click(); });
    await settle();
    const dlg = popup()!;
    const titleId = dlg.getAttribute('aria-labelledby')!;
    expect(document.getElementById(titleId)?.textContent).toBe(S.agentApiKeyGeneratedTitle);
    const input = dlg.querySelector('input#generated-api-key') as HTMLInputElement;
    expect(input.value).toBe(NEW_KEY);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('data-slot')).toBe('ds-input');
    expect(dlg.querySelector('code')!.className).toContain('bg-ds-surface-sunk');
    expect(dlg.querySelector('pre')!.className).toContain('bg-ds-surface-sunk');
    expect(btn(S.agentApiKeyDone)!.className).toContain('bg-ds-action');
  });

  it('⭐소스: ui/dialog · ui/confirm-dialog · ui/input이 없고 파일 어디에도 옛 글자 크기 · 색 토큰이 없다(토스트 훅만 예외) — 되돌리면 RED', () => {
    const src = readFileSync(join(__dirname, 'agent-api-key-manager.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const imports = src.match(/from '@\/components\/ui\/[^']+'/g) ?? [];
    expect(imports).toEqual(["from '@/components/ui/toast'"]);
    for (const bad of ['text-muted-foreground', 'text-sm', 'text-xs', 'bg-muted', 'border-border', 'text-foreground', 'text-destructive', 'text-warning-strong']) expect(src, bad).not.toContain(bad);
  });
});
