// @vitest-environment jsdom
//
// story #2667(2026-08-15, 선생님 실환 제보) — recruit 완료가 최초 자동 키를 조용히 rotate.
// recruiter-client.equip-warning-mount.test.tsx의 실 마운트 패턴을 재사용(source-regex로는
// fetch body/분기 실행 여부를 못 잡는다 — 이번 판의 성패축 그대로 재적용).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RecruiterClient } from './recruiter-client';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, vars?: Record<string, unknown>) =>
      vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`;
    t.rich = (key: string) => `${ns}.${key}`;
    t.markup = (key: string) => `${ns}.${key}`;
    t.raw = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
  useLocale: () => 'ko',
}));

vi.mock('@/app/onboarding/onboarding-telemetry', () => ({
  emitOnboardingEvent: vi.fn(),
  beaconOnboardingEvent: vi.fn(),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

const ROLE = {
  id: 'role-1', slug: 'backend', name: 'Backend Engineer', category: 'engineering',
  description: 'desc', default_tool_groups: ['stories', 'tasks'],
};

function baseHandlers(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
    if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
    if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
    if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [{ id: 'existing-agent-1', name: 'Existing Agent', type: 'agent' }] });
    throw new Error(`unmocked fetch: ${method} ${url}`);
  });
}

async function mountAndSelectRole(container: HTMLDivElement, roleName = ROLE.name) {
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const roleCard = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(roleName));
  expect(roleCard, 'role card should be rendered').toBeTruthy();
  await act(async () => { roleCard!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // STEP1 → STEP2 (scope 선택 화면).
  let nextButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'recruiter.next');
  await act(async () => { nextButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // STEP2: scopeMode 기본값이 'projects'라 project 미선택 상태면 next가 disabled — 'org'
  // 카드를 눌러 스코프를 바꿔 그 가드를 우회한다(프로젝트 선택 자체는 이 스토리의 관심사 밖).
  const orgScopeCard = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('settings.agentScopeAllProjects'));
  expect(orgScopeCard, 'org scope card should be rendered').toBeTruthy();
  await act(async () => { orgScopeCard!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // STEP2 → STEP3.
  nextButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'recruiter.next');
  expect(nextButtons.length).toBeGreaterThan(0);
  await act(async () => { nextButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  return root;
}

describe('RecruiterClient — recruit 키 무고지 rotate 방지 (story #2667)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('신규 에이전트: POST /api/agents가 defer_key_issuance:true를 싣는다(recruit이 유일 발급처)', async () => {
    baseHandlers(fetchMock);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      if (url === '/api/agents' && method === 'POST') {
        return jsonResponse({ data: { id: 'new-agent-1' } });
      }
      if (url === '/api/agents/new-agent-1/recruit' && method === 'POST') {
        return jsonResponse({ data: { agent_id: 'new-agent-1', api_key: 'sk_live_final', mcp_config: { mcpServers: {} }, tool_allowlist: ['stories'], default_transport: 'stdio' } });
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    });

    root = await mountAndSelectRole(container);

    // STEP2: 이름 입력.
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'QA New Agent');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const recruitCta = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.recruitCta');
    expect(recruitCta).toBeTruthy();
    await act(async () => { recruitCta!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const createCall = fetchMock.mock.calls.find((c) => c[0] === '/api/agents' && (c[1] as RequestInit)?.method === 'POST');
    expect(createCall).toBeTruthy();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.defer_key_issuance).toBe(true);

    const recruitCall = fetchMock.mock.calls.find((c) => c[0] === '/api/agents/new-agent-1/recruit');
    expect(recruitCall).toBeTruthy();
  });

  it('기존 에이전트(활성 키 있음): 경고가 뜨고 recruit은 확認 전까지 안 불린다', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [{ id: 'existing-agent-1', name: 'Existing Agent', type: 'agent' }] });
      if (url === '/api/agents/existing-agent-1/api-keys') return jsonResponse({ data: [{ id: 'key-1', revoked_at: null }] });
      if (url === '/api/agents/existing-agent-1/recruit' && method === 'POST') {
        return jsonResponse({ data: { agent_id: 'existing-agent-1', api_key: 'sk_live_rotated', mcp_config: { mcpServers: {} }, tool_allowlist: ['stories'], default_transport: 'stdio' } });
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    });

    root = await mountAndSelectRole(container);

    // agentMode를 existing으로 전환 + 기존 에이전트 선택.
    const existingTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.agentModeExisting');
    await act(async () => { existingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'existing-agent-1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const recruitCta = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.recruitCta');
    await act(async () => { recruitCta!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // 경고 렌더 + recruit 미호출.
    expect(container.textContent).toContain('recruiter.recruitExistingKeyWarningTitle');
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/agents/existing-agent-1/recruit')).toBe(false);

    // 확認 CTA 클릭 → 그제서야 recruit 호출.
    const confirmCta = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.recruitExistingKeyWarningCta');
    expect(confirmCta).toBeTruthy();
    await act(async () => { confirmCta!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/agents/existing-agent-1/recruit')).toBe(true);
  });

  it('기존 에이전트(활성 키 없음): 경고 없이 바로 recruit이 불린다(음성대조 — 과잉 경고 아님)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [ROLE] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [{ id: 'existing-agent-2', name: 'Keyless Agent', type: 'agent' }] });
      if (url === '/api/agents/existing-agent-2/api-keys') return jsonResponse({ data: [] });
      if (url === '/api/agents/existing-agent-2/recruit' && method === 'POST') {
        return jsonResponse({ data: { agent_id: 'existing-agent-2', api_key: 'sk_live_first', mcp_config: { mcpServers: {} }, tool_allowlist: ['stories'], default_transport: 'stdio' } });
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    });

    root = await mountAndSelectRole(container);

    const existingTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.agentModeExisting');
    await act(async () => { existingTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'existing-agent-2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const recruitCta = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'recruiter.recruitCta');
    await act(async () => { recruitCta!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('recruiter.recruitExistingKeyWarningTitle');
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/agents/existing-agent-2/recruit')).toBe(true);
  });
});
