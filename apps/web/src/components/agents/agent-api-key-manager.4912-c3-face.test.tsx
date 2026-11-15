// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';
import { AgentApiKeyManager } from './agent-api-key-manager';

// story 4912 (C3) — the «키» tab's key manager on the ds parts: the detail's tab = a ds card (DetailCard) with the title + description in its header; inside the «키 관리» panel (compact) the content sits on the panel (no card in a panel).
// Buttons ds (refresh secondary · issue primary · revoke danger), scope = ds Chip (admin = needs-hand), key rows on the sunk face, the expiry choice = the ds NativeSelect, text on the ds scale. Behaviour untouched.
const { addToast } = vi.hoisted(() => ({ addToast: () => {} })); // ONE identity: the load effect depends on it
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = koMessages.settings;
let container: HTMLDivElement;
let root: Root;

const KEYS = [
  { id: 'k1', key_prefix: 'sk_live_aaaa', created_at: '2026-08-01T00:00:00Z', last_used_at: null, revoked_at: null, expires_at: null, scope: ['read', 'admin'] },
];

async function mount(compact: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: KEYS }), { status: 200 })));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages}><AgentApiKeyManager agentId="agent-1" agentName="테스트 에이전트" compact={compact} /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const mgr = () => document.querySelector('[data-testid="agent-api-key-manager"]') as HTMLElement;
const btn = (label: string) => Array.from(mgr().querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AgentApiKeyManager — 4912 C3: the ds face', () => {
  it('⭐상세 «키» 탭 = ds 카드(DetailCard) — 머리에 제목(h2) + 설명, 안쪽 첫 줄에 단추 셋', async () => {
    await mount(false);
    expect(mgr().getAttribute('data-slot')).toBe('ds-card');
    expect(mgr().querySelector('[data-slot="detail-card-header"] h2')?.textContent).toBe(S.agentApiKeyListTitle.replace('{name}', '테스트 에이전트'));
    expect(mgr().querySelector('[data-slot="detail-card-header"]')?.textContent).toContain(S.agentApiKeyListDescription);
    expect(mgr().querySelector('[data-slot="detail-card-body"] button')).not.toBeNull();
  });

  it('⭐«키 관리» 패널 안(compact) = 카드 없이 패널 면 위에 바로 — 제목 · 설명은 패널 머리가 맡는다', async () => {
    await mount(true);
    expect(mgr().getAttribute('data-slot')).toBeNull();
    expect(mgr().querySelector('h2')).toBeNull();
    expect(mgr().querySelector('[data-slot="ds-card"]')).toBeNull();
    expect(btn(S.agentApiKeyRefresh)).toBeTruthy(); // the rest is all there
  });

  it('⭐단추: 새로고침 = secondary · 키 바꾸기 = primary · 키 줄의 무효화 = danger (옛 ui 단추 변형이 아니다)', async () => {
    await mount(false);
    expect(btn(S.agentApiKeyRefresh).className).toContain('border-ds-line-control');
    expect(btn(S.agentApiKeyReplaceCta).className).toContain('bg-ds-action');
    expect(btn(S.agentApiKeySingleRevokeConfirmCta).className).toContain('border-ds-failed');
  });

  it('⭐키 줄 = sunk 면 상자 · 범위 칩 = ds Chip(admin만 needs-hand, 나머지 중립)', async () => {
    await mount(false);
    const chips = Array.from(mgr().querySelectorAll('[data-slot="ds-chip"]')) as HTMLElement[];
    expect(chips.map((c) => [c.textContent, c.getAttribute('data-tone')])).toEqual([['read', 'neutral'], ['admin', 'needs-hand']]);
    expect(chips[0]!.closest('div.rounded-ds-control')!.className).toContain('bg-ds-surface-sunk');
  });

  it('⭐만료 선택 = ds NativeSelect(라벨이 그 칸에 묶여 있다 — htmlFor)', async () => {
    await mount(false);
    const select = mgr().querySelector('[data-slot="ds-select"] select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const label = mgr().querySelector(`label[for="${select.id}"]`);
    expect(label?.textContent).toBe(S.agentApiKeyExpiryLabel);
  });

  it('⭐두 매니저가 한 화면에 있어도 만료 칸 id가 겹치지 않고 각 라벨이 제 칸에 묶인다 — 고정 id로 되돌리면 RED (codex)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages}>
          <AgentApiKeyManager agentId="agent-1" agentName="하나" />
          <AgentApiKeyManager agentId="agent-2" agentName="둘" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    const selects = Array.from(document.querySelectorAll('[data-slot="ds-select"] select')) as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    expect(new Set(selects.map((x) => x.id)).size).toBe(2);
    for (const sel of selects) expect(document.querySelector(`label[for="${sel.id}"]`)?.closest('[data-testid="agent-api-key-manager"]')).toBe(sel.closest('[data-testid="agent-api-key-manager"]'));
  });

  it('⭐소스: ui/button · ui/section-card · ui/select · ui/textarea가 없고 목록 · 머리 줄에 옛 글자 크기 · 색 토큰이 없다(키 창 안은 옛 Dialog 그대로) — 되돌리면 RED', () => {
    const src = readFileSync(join(__dirname, 'agent-api-key-manager.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const bad of ["@/components/ui/button", "@/components/ui/section-card", "@/components/ui/select", "@/components/ui/textarea", 'SectionCard']) expect(src, bad).not.toContain(bad);
    // the part above the dialogs (header · failure line · key rows) — the dialogs are the old Dialog's own surface and stay as they were
    const face = src.slice(0, src.indexOf('<Dialog open={revokeConfirmDialog}'));
    for (const bad of ['text-muted-foreground', 'text-sm', 'text-xs', 'text-destructive', 'text-warning-strong', 'bg-warning-tint', 'border rounded-md']) expect(face, bad).not.toContain(bad);
  });
});
