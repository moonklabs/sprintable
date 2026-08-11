// @vitest-environment jsdom
//
// 카디르 QA(#2822, 2026-08-03) — story #2433(B) 「PATCH 실패 시 경고 배너가 실제로 뜨는가」를
// 소스텍스트 패턴매칭이 아니라 실제 마운트+렌더로 검증한다. 이 컴포넌트 파일에는 지금까지
// 마운트 테스트가 0건이었다(전부 source regex 관례) — PATCH를 진짜로 실패시켜 배너 DOM이
// 실제로 나타나는지가 이번 판의 성패축이라(PO 지시) 새 테스트 형태로 직접 만든다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RecruiterClient } from './recruiter-client';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`,
  useLocale: () => 'ko',
}));

vi.mock('@/app/onboarding/onboarding-telemetry', () => ({
  emitOnboardingEvent: vi.fn(),
  beaconOnboardingEvent: vi.fn(),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('RecruiterClient equip-skip — PATCH 실패 시 경고 배너 실제 렌더(마운트 테스트)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });

      if (url === '/api/agents' && method === 'POST') {
        return jsonResponse({
          data: { id: 'agent-under-test', mcp_config: { mcpServers: { 'sprintable-mcp': {} } }, api_key: 'sk_test_placeholder' },
        });
      }

      if (url === '/api/team-members/agent-under-test' && method === 'PATCH') {
        // story #2433(B) — 여기가 이번 QA의 성패: 이 PATCH를 실제로 실패시킨다.
        return jsonResponse({ error: 'boom' }, false, 500);
      }

      throw new Error(`unmocked fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('POST /api/agents 성공 + PATCH /api/team-members/{id} 실패 → equipRuntimeSaveWarning 배너가 DOM에 실제로 나타난다', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    // 마운트 시점 useEffect(role-templates/projects/runtime-capabilities) flush.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // STEP1: "역할 없이(키만)" 카드 클릭 → equipSkip=true.
    const skipButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('recruiter.equipSkipCardTitle'),
    );
    expect(skipButtons.length).toBe(1);
    await act(async () => { skipButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // "다음" 버튼 클릭 → STEP2.
    const nextButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent === 'recruiter.next',
    );
    expect(nextButtons.length).toBeGreaterThan(0);
    await act(async () => { nextButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // STEP2: 이름 입력(handleEquipCreate가 빈 이름이면 조기 return하므로 필수).
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'QA Mount Test Agent');
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // "생성" CTA 클릭 → handleEquipCreate() 실행(POST 성공 → PATCH 실패 경로).
    const createButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent === 'recruiter.equipCreateCta',
    );
    expect(createButtons.length).toBe(1);
    expect((createButtons[0] as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { createButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // handleEquipCreate 내부 await 체인(POST → PATCH → 상태갱신) flush.
    await act(async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // 실제로 불린 fetch 호출을 확認(경로 실측 — 추측 아님).
    const calledUrls = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0]}`);
    expect(calledUrls).toContain('POST /api/agents');
    expect(calledUrls).toContain('PATCH /api/team-members/agent-under-test');

    // ⭐성패: 경고 배너가 실제 DOM에 렌더됐는가.
    expect(container.textContent).toContain('recruiter.equipRuntimeSaveWarning');
    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain('recruiter.equipRuntimeSaveWarning');
  });

  it('음성대조 — PATCH가 성공하면 배너가 안 뜬다(과잉 배너 아님)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/role-templates')) return jsonResponse({ data: [] });
      if (url === '/api/projects') return jsonResponse({ data: [{ id: 'proj-1', name: 'Proj 1' }] });
      if (url === '/api/runtime-capabilities') return jsonResponse({ data: [] });
      if (url.startsWith('/api/team-members?')) return jsonResponse({ data: [] });
      if (url === '/api/agents' && method === 'POST') {
        return jsonResponse({ data: { id: 'agent-2', mcp_config: { mcpServers: { 'sprintable-mcp': {} } }, api_key: 'sk_test' } });
      }
      if (url === '/api/team-members/agent-2' && method === 'PATCH') return jsonResponse({ data: {} }, true, 200);
      throw new Error(`unmocked fetch: ${method} ${url}`);
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<RecruiterClient projectId="proj-1" showTopBar={false} />);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const skipButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('recruiter.equipSkipCardTitle'),
    );
    await act(async () => { skipButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const nextButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'recruiter.next');
    await act(async () => { nextButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'QA Mount Test Agent 2');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const createButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'recruiter.equipCreateCta');
    await act(async () => { createButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('recruiter.equipRuntimeSaveWarning');
  });
});
