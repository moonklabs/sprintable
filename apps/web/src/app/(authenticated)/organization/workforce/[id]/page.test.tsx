// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — fetchOrgContext의 projectRes/meRes 둘 다
// 부수(ok?채움:방치)인데 catch가 어디에도 없어, 하나가 네트워크단 reject하면 나머지도
// 조용히 못 채워지던 결함의 회귀가드. 전체 기능 스위트가 아니라 이 격리 하나만 좁게 검증.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

// story #3519 harness gotcha — useRouter가 매 렌더 새 객체를 반환하면 fetchAgent의
// useCallback identity가 매번 바뀌어 로드 useEffect가 무한 재실행된다(fetchAgent가
// [id, router] 의존). router mock 자체를 안정 참조로 고정해야 한다.
const { routerReplaceMock, routerMock } = vi.hoisted(() => {
  const routerReplaceMock = vi.fn();
  return { routerReplaceMock, routerMock: { replace: routerReplaceMock, push: vi.fn() } };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useRouter: () => routerMock,
}));

vi.mock('@/components/agents/agent-api-key-manager', () => ({
  AgentApiKeyManager: () => <div data-testid="stub-agent-api-key-manager" />,
}));
vi.mock('@/components/agents/agent-connection-settings-section', () => ({ AgentConnectionSettingsSection: () => null }));
vi.mock('@/components/agents/messaging-policy-section', () => ({ MessagingPolicySection: () => null }));
vi.mock('@/components/shared/avatar-edit-card', () => ({ AvatarEditCard: () => null }));
vi.mock('@/components/agents/member-notification-preferences-summary', () => ({ MemberNotificationPreferencesSummary: () => null }));
// story #3519 — projects prop 확인용. 실제 렌더 대신 개수만 텍스트로 노출한다.
vi.mock('@/components/settings/agent-project-access-section', () => ({
  AgentProjectAccessSection: ({ projects }: { projects: { id: string; name: string }[] }) => (
    <div data-testid="project-access-projects-count">{projects.length}</div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerReplaceMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const AGENT = {
  id: 'agent-1', name: '에이전트1', type: 'agent', role: 'member', project_id: 'proj-1',
  is_active: true, webhook_url: null, created_by: 'human-1', fakechat_port: null, runtime_type: 'claude-code',
};

function stubFetch(opts: { meReject?: boolean; agent?: typeof AGENT } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/team-members/agent-1') return { ok: true, json: async () => ({ data: opts.agent ?? AGENT }) };
    if (url.startsWith('/api/agents/') && url.endsWith('/api-key')) return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'p1', name: '프로젝트 A' }, { id: 'p2', name: '프로젝트 B' }] }) };
    if (url === '/api/me') {
      if (opts.meReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: { user_id: 'u1', role: 'admin' } }) };
    }
    if (url.startsWith('/api/webhooks/config')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  const { default: AgentDetailPage } = await import('./page');
  await act(async () => { root.render(wrap(<AgentDetailPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('AgentDetailPage — fetchOrgContext 격리(story #3519)', () => {
  it('/api/me가 네트워크 reject해도 /api/projects(주)는 그대로 채워진다', async () => {
    stubFetch({ meReject: true });
    await mount();
    expect(container.querySelector('[data-testid="project-access-projects-count"]')?.textContent).toBe('2');
  });
});

// story #3994 CHANGES-1(페드루 PO 판정 2026-09-17) — 이 상세 화면이 에이전트 종류
// 구분 없이 AgentApiKeyManager(키 발급)를 그려, 「시스템 발행」에도 키를 발급할 수
// 있는 모양이었다(발급된 키로 고객 에이전트가 그 이름을 사칭해 메시지를 보낼 수
// 있는 실 문제). 목록과 같은 중립 설명 1줄로 대체.
describe('AgentDetailPage — 시스템 발행 키 관리 숨김(story #3994 CHANGES-1)', () => {
  it('⭐일반 에이전트(claude-code) — 키 관리 영역이 그대로 뜬다(회귀 0)', async () => {
    stubFetch({ agent: { ...AGENT, runtime_type: 'claude-code' } });
    await mount();
    expect(container.querySelector('[data-testid="stub-agent-api-key-manager"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-detail-system-publisher-notice"]')).toBeNull();
  });

  it('⭐「시스템 발행」(runtime_type=system-publisher) — 키 관리 영역 0, 중립 설명 1줄로 대체', async () => {
    stubFetch({ agent: { ...AGENT, name: '시스템 발행', runtime_type: 'system-publisher' } });
    await mount();
    expect(container.querySelector('[data-testid="stub-agent-api-key-manager"]')).toBeNull();
    const notice = container.querySelector('[data-testid="agent-detail-system-publisher-notice"]');
    expect(notice?.textContent).toBe('Sprintable이 자동으로 남기는 알림·기록의 보낸 이예요 — 따로 연결하지 않아도 돼요.');
  });
});
