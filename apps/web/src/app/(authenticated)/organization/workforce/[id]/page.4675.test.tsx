// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · AC3 · Yuna §I ②③) — the workforce detail says where the agent is: a reported session → «지금 도는 컴퓨터:
// {name} · {state}» (the DM strip's word) · bound but never run → «{name}에 연결됨 · 아직 안 돌았어요» · neither → no line. The
// «연결된 기기 보기» link (to `/desktop#device=<setup_id>`) for an org owner/admin only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { routerMock } = vi.hoisted(() => ({ routerMock: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'agent-1' }), useRouter: () => routerMock }));
vi.mock('@/components/agents/agent-api-key-manager', () => ({ AgentApiKeyManager: () => null }));
vi.mock('@/components/agents/agent-connection-settings-section', () => ({ AgentConnectionSettingsSection: () => null }));
vi.mock('@/components/agents/messaging-policy-section', () => ({ MessagingPolicySection: () => null }));
vi.mock('@/components/shared/avatar-edit-card', () => ({ AvatarEditCard: () => null }));
vi.mock('@/components/agents/member-notification-preferences-summary', () => ({ MemberNotificationPreferencesSummary: () => null }));
vi.mock('@/components/settings/agent-project-access-section', () => ({ AgentProjectAccessSection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const AGENT = { id: 'agent-1', name: '조사', type: 'agent', role: 'member', project_id: 'proj-1', is_active: true, webhook_url: null, created_by: 'human-1', fakechat_port: null, runtime_type: 'claude-code' };
const SETUP = '11111111-1111-4111-8111-111111111111';

function stub(session: object | null, role = 'admin') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/team-members/agent-1') return { ok: true, json: async () => ({ data: AGENT }) };
    if (url === '/api/agents/agent-1/desktop-session') return session ? { ok: true, json: async () => session } : { ok: false, status: 404, json: async () => null };
    if (url.startsWith('/api/agents/') && url.endsWith('/api-key')) return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u1', role } }) };
    if (url.startsWith('/api/webhooks/config')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
}
async function mount() {
  const { default: AgentDetailPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentDetailPage /></NextIntlClientProvider>); });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
// the page's module graph (with the strip's word table) takes a few seconds to load the first time — not the test's own time
const SLOW = 30_000;
const line = () => container.querySelector('[data-testid=agent-running-on]');

describe('[SID:4675] AgentDetailPage — «지금 도는 컴퓨터»', () => {
  it('a reported session → the line with the strip\'s word · the link to that device for an admin', async () => {
    stub({ setup_id: SETUP, device_name: 'yoonjae의 맥', state: 'working', activity: 'working', limit: null, bound_setup_id: SETUP, bound_device_name: 'yoonjae의 맥' });
    await mount();
    expect(line()?.textContent).toContain('지금 도는 컴퓨터: yoonjae의 맥 · 작업 중'); // reverted → null
    const link = line()?.querySelector('[data-testid=agent-see-devices]') as HTMLAnchorElement;
    expect(link.textContent).toBe('연결된 기기 보기');
    expect(link.getAttribute('href')).toBe(`/desktop#device=${SETUP}`);
  }, SLOW);

  it('bound, never run → «{name}에 연결됨 · 아직 안 돌았어요» · a member sees no link', async () => {
    stub({ setup_id: null, device_name: null, state: null, bound_setup_id: SETUP, bound_device_name: '스튜디오 맥' }, 'member');
    await mount();
    expect(line()?.textContent).toBe('스튜디오 맥에 연결됨 · 아직 안 돌았어요');
    expect(line()?.querySelector('[data-testid=agent-see-devices]')).toBeNull();
  }, SLOW);

  it('a limit the app held wears «사용 한도» (the strip\'s rule) · nothing known → no line at all', async () => {
    stub({ setup_id: SETUP, device_name: 'yoonjae의 맥', state: 'waiting_input', activity: 'waiting_input', limit: { held: 'screen' } });
    await mount();
    expect(line()?.textContent).toContain('yoonjae의 맥 · 사용 한도');
    await act(async () => { root.unmount(); }); root = createRoot(container); vi.resetModules();
    stub({ setup_id: null, device_name: null, state: null, bound_setup_id: null, bound_device_name: null });
    await mount();
    expect(line()).toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container); vi.resetModules();
    stub(null); // an older server (404) — the page as it was
    await mount();
    expect(line()).toBeNull();
  }, SLOW);
});
