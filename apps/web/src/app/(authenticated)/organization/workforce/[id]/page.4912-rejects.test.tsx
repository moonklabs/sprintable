// @vitest-environment jsdom
//
// story 4912 (PO 11-13) — a REJECTED request (the network went away) said nothing on the detail page's save handlers: the rename left `savingEdit` true for good (the save button stayed disabled), the runtime save · the deactivate toggle ·
// the webhook save threw an unhandled rejection. Now the same error toast as an HTTP error answer speaks and the control comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
const { routerMock } = vi.hoisted(() => ({ routerMock: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'agent-1' }), useRouter: () => routerMock }));
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
vi.mock('@/components/agents/agent-api-key-manager', () => ({ AgentApiKeyManager: () => <div /> }));
vi.mock('@/components/agents/agent-connection-settings-section', () => ({ AgentConnectionSettingsSection: () => <div /> }));
vi.mock('@/components/agents/messaging-policy-section', () => ({ MessagingPolicySection: () => <div /> }));
vi.mock('@/components/shared/avatar-edit-card', () => ({ AvatarEditCard: () => <div /> }));
vi.mock('@/components/agents/member-notification-preferences-summary', () => ({ MemberNotificationPreferencesSummary: () => null }));
vi.mock('@/components/settings/agent-project-access-section', () => ({ AgentProjectAccessSection: () => <div /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { mode = 'reject'; addToast.mockClear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const AGENT = { id: 'agent-1', name: '에이전트1', type: 'agent', role: 'member', project_id: 'proj-1', is_active: true, webhook_url: null, created_by: 'human-1', fakechat_port: null, runtime_type: 'claude-code' };
const WEBHOOK = { id: 'w-1', member_id: 'agent-1', url: 'https://old.example.com/hook', is_active: true };

// 'reject' = every write is a rejected request · 'webhook-saved' = the webhook PUT succeeds but the re-read of the configs rejects · 'unreadable' = the PATCH answers 200 with a body that cannot be read
let mode: 'reject' | 'webhook-saved' | 'unreadable' = 'reject';
let webhookWritten = false;
function stubFetch() {
  webhookWritten = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (mode === 'webhook-saved' && url.startsWith('/api/webhooks/config')) {
      if (method === 'PUT') { webhookWritten = true; return { ok: true, json: async () => ({ data: WEBHOOK }) }; }
      if (webhookWritten) throw new TypeError('network down'); // the RE-READ after the save
    }
    if (mode === 'unreadable' && method === 'PATCH') return { ok: true, status: 200, json: async () => { throw new SyntaxError('unreadable'); } };
    if (method !== 'GET' && mode === 'reject') throw new TypeError('network down'); // every write is a REJECTED request
    if (method !== 'GET' && mode === 'webhook-saved') return { ok: true, json: async () => ({ data: {} }) };
    if (method !== 'GET') throw new TypeError('network down');
    if (url === '/api/team-members/agent-1') return { ok: true, json: async () => ({ data: AGENT }) };
    if (url.startsWith('/api/agents/') && url.endsWith('/api-key')) return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u1', role: 'admin' } }) };
    if (url.startsWith('/api/webhooks/config')) return { ok: true, json: async () => ({ data: [WEBHOOK] }) };
    return { ok: false, json: async () => null };
  }));
}
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
async function mount() {
  stubFetch();
  const { default: Page } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Page /></NextIntlClientProvider>); });
  await settle(); await settle();
}
const ERR = { type: 'error', title: koMessages.common.error };

describe('AgentDetailPage — 4912: a rejected save request says so', () => {
  it('⭐이름 저장이 거절되면 오류 토스트 + [저장]이 다시 눌린다(전엔 savingEdit이 true로 남아 영영 잠겼다) — catch/finally를 걷으면 RED', async () => {
    await mount();
    await act(async () => { (container.querySelector(`button[aria-label="${koMessages.common.edit}"]`) as HTMLElement).click(); });
    const save = () => container.querySelector(`button[aria-label="${koMessages.common.save}"]`) as HTMLButtonElement;
    await act(async () => { save().click(); });
    await settle();
    expect(addToast).toHaveBeenCalledWith(ERR);
    expect(save().disabled, 'not stuck disabled').toBe(false);
  });

  it('⭐비활성화(확인 뒤 PATCH)가 거절되면 오류 토스트 + 메뉴 항목이 다시 눌린다(가드가 풀린다)', async () => {
    await mount();
    await act(async () => { (container.querySelector('[data-testid="agent-detail-actions"]') as HTMLElement).click(); });
    await act(async () => { (document.querySelector('[role="menuitem"]') as HTMLElement).click(); });
    await settle();
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.settings.deactivateAgentDialogConfirm)!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(addToast).toHaveBeenCalledWith(ERR);
    await act(async () => { (container.querySelector('[data-testid="agent-detail-actions"]') as HTMLElement).click(); });
    const item = document.querySelector('[role="menuitem"]') as HTMLElement;
    expect(item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true', 'the guard is free again').toBe(false);
  });

  it('⭐웹훅 주소 저장이 거절돼도 오류 토스트 + [저장]이 «...»에 갇히지 않는다', async () => {
    await mount();
    const card = container.querySelector('[data-testid="agent-detail-card-webhook"]') as HTMLElement;
    const input = card.querySelector('input[type="url"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://new.example.com/hook');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = () => [...card.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save || b.textContent === '...') as HTMLButtonElement;
    await act(async () => { save().click(); });
    await settle();
    expect(addToast).toHaveBeenCalledWith(ERR);
    expect(save().textContent).toBe(koMessages.common.save);
  });

  it('⭐웹훅 저장은 성공했는데 설정 «다시 읽기»만 거절되면 성공 토스트만 — 오류 토스트가 덧붙지 않는다(codex 2차) — .catch를 걷으면 RED', async () => {
    mode = 'webhook-saved';
    await mount();
    const card = container.querySelector('[data-testid="agent-detail-card-webhook"]') as HTMLElement;
    const input = card.querySelector('input[type="url"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://new.example.com/hook');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...card.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save) as HTMLButtonElement;
    await act(async () => { save.click(); });
    await settle(); await settle();
    expect(webhookWritten).toBe(true);
    expect(addToast).toHaveBeenCalledWith({ type: 'success', title: koMessages.settings.webhookUrlSavedToast });
    expect(addToast).not.toHaveBeenCalledWith(ERR);
  });

  it('⭐활성 토글의 답이 200인데 읽을 수 없으면 오류 토스트(처리 안 된 거절이 아니다) · 가드가 풀린다(codex 2차)', async () => {
    mode = 'unreadable';
    await mount();
    await act(async () => { (container.querySelector('[data-testid="agent-detail-actions"]') as HTMLElement).click(); });
    await act(async () => { (document.querySelector('[role="menuitem"]') as HTMLElement).click(); });
    await settle();
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.settings.deactivateAgentDialogConfirm)!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(addToast).toHaveBeenCalledWith(ERR);
  });

  it('⭐런타임 저장 · 이름 저장 · 활성 토글 · 웹훅 저장 — 요청을 기다리는 모든 저장 처리기가 catch를 가진다(소스 가드 — 런타임 저장은 고르는 칸이 무거워 여기서 줄 수만 본다)', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    for (const name of ['handleSaveEdit', 'handleSaveRuntime', 'handleToggleActive', 'handleSaveWebhook']) {
      const start = src.indexOf(`const ${name} = async`);
      expect(start, name).toBeGreaterThan(-1);
      const end = src.indexOf('\n  };', start);
      expect(src.slice(start, end), `${name} has a catch`).toMatch(/\} catch \{/);
    }
  });
});
