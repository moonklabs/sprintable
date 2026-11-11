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
// useCallback identity가 매번 바뀌어 로드 useEffect가 무한 재실행된다(story 4889 前 fetchAgent가
// [id, router] 의존이었다 — 지금은 [id]뿐). router mock은 그래도 안정 참조로 고정해 둔다.
const { routerReplaceMock, routerPushMock, routerMock, paramId } = vi.hoisted(() => {
  const routerReplaceMock = vi.fn();
  const routerPushMock = vi.fn();
  const paramId = { current: 'agent-1' };
  return { paramId, routerReplaceMock, routerPushMock, routerMock: { replace: routerReplaceMock, push: routerPushMock } };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: paramId.current }),
  useRouter: () => routerMock,
}));

vi.mock('@/components/agents/agent-api-key-manager', () => ({
  AgentApiKeyManager: () => <div data-testid="stub-agent-api-key-manager" />,
}));
vi.mock('@/components/agents/agent-connection-settings-section', () => ({
  AgentConnectionSettingsSection: () => <div data-testid="stub-agent-connection-settings-section" />,
}));
vi.mock('@/components/agents/messaging-policy-section', () => ({
  MessagingPolicySection: () => <div data-testid="stub-messaging-policy-section" />,
}));
vi.mock('@/components/shared/avatar-edit-card', () => ({
  AvatarEditCard: () => <div data-testid="stub-avatar-edit-card" />,
}));
vi.mock('@/components/agents/member-notification-preferences-summary', () => ({ MemberNotificationPreferencesSummary: () => null }));
// story #3519 — projects prop 확인용. 실제 렌더 대신 개수만 텍스트로 노출한다.
// story #3994 CHANGES-2 — canEdit prop도 같이 노출(시스템 발행 상세에서 false로
// 좁혀지는지 이 스텁의 DOM으로 검증).
vi.mock('@/components/settings/agent-project-access-section', () => ({
  AgentProjectAccessSection: ({ projects, canEdit }: { projects: { id: string; name: string }[]; canEdit: boolean }) => (
    <div data-testid="project-access-projects-count" data-can-edit={String(canEdit)}>{projects.length}</div>
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
  routerPushMock.mockReset();
  paramId.current = 'agent-1';
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

// story #4129 AC3 — 워크포스 상세도 목록과 같은 1줄(agent-management-tab.tsx의
// formatAgentRuntimeLine 공유)·배지를 보인다.
describe('AgentDetailPage — story #4129 런타임 신원 1줄 + 재기동 배지', () => {
  function stubFetchWithAgent(extra: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url !== 'string') return { ok: false, json: async () => null };
      if (url === '/api/team-members/agent-1') return { ok: true, json: async () => ({ data: { ...AGENT, ...extra } }) };
      if (url.startsWith('/api/agents/') && url.endsWith('/api-key')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u1', role: 'admin' } }) };
      if (url.startsWith('/api/webhooks/config')) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: false, json: async () => null };
    }));
  }

  it('client_version·session_started_at이 있으면 런타임 1줄을 보인다', async () => {
    stubFetchWithAgent({ client_version: '2.1.0', session_started_at: new Date().toISOString() });
    await mount();
    expect(container.textContent).toContain('런타임 v2.1.0');
  });

  it('needs_restart=true면 «재기동 필요» 배지를 보인다', async () => {
    stubFetchWithAgent({ client_version: '2.1.0', needs_restart: true });
    await mount();
    expect(container.textContent).toContain('재기동 필요');
  });

  it('needs_restart=false/null이면 배지를 보이지 않는다', async () => {
    stubFetchWithAgent({ client_version: '2.1.0', needs_restart: null });
    await mount();
    expect(container.textContent).not.toContain('재기동 필요');
  });

  it('런타임 신원 데이터가 전부 없으면(마이그레이션 전 응답 등) 줄 자체를 숨긴다 — placeholder 없음', async () => {
    stubFetchWithAgent({});
    await mount();
    expect(container.textContent).not.toContain('런타임 v');
    expect(container.textContent).not.toContain('세션 시작');
  });
});

// story #3994 CHANGES-1(페드루 PO 판정 2026-09-17) — 이 상세 화면이 에이전트 종류
// 구분 없이 AgentApiKeyManager(키 발급)를 그려, 「시스템 발행」에도 키를 발급할 수
// 있는 모양이었다(발급된 키로 고객 에이전트가 그 이름을 사칭해 메시지를 보낼 수
// 있는 실 문제). 목록과 같은 중립 설명 1줄로 대체.
describe('AgentDetailPage — 시스템 발행 키 관리 숨김(story #3994 CHANGES-1)', () => {
  it('⭐일반 에이전트(claude-code) — 편집 가능한 것 전부 그대로 뜬다(회귀 0)', async () => {
    stubFetch({ agent: { ...AGENT, runtime_type: 'claude-code' } });
    await mount();
    expect(container.querySelector('[data-testid="stub-agent-api-key-manager"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stub-agent-connection-settings-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stub-avatar-edit-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stub-messaging-policy-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-access-projects-count"]')?.getAttribute('data-can-edit')).toBe('true');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '비활성화' || b.textContent === '활성화')).toBe(true);
    // 「저장」 버튼 2개(런타임+webhook) — 시스템 발행이면 런타임 쪽은 읽기전용 분기라
    // 통째로 안 그려져 1개(webhook)만 남는다(아래 짝 테스트와 대칭 비교).
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent === '저장').length).toBe(2);
    const webhookSwitch = container.querySelector('[role="switch"]');
    expect(webhookSwitch?.hasAttribute('data-disabled')).toBe(false);
    expect(container.querySelector('[data-testid="agent-detail-system-publisher-notice"]')).toBeNull();
    // story #3994 CHANGES-3(유나 재앵커 적발) — Fakechat(SSE) 인라인 섹션은 일반
    // 에이전트에겐 그대로 뜬다(회귀 0).
    expect(container.textContent).toContain('실시간 연결');
    // story #3994 CHANGES-4(페드루 PO C3/C4) — 런타임 카드·알림 채널 카드·알림
    // 설정 요약 카드도 일반 에이전트에겐 그대로 뜬다(회귀 0).
    expect(container.textContent).toContain('런타임 타입');
    expect(container.textContent).toContain('알림 채널');
    expect(container.textContent).toContain('수신 계약 요약');
  });

  // story #3994 CHANGES-2(페드루 PO 판정 2026-09-17) — 유나 전수+PO 코드대조 결과
  // 「시스템 발행」에 손댈 수 있는 자리가 키 발급·연결 설정 말고도 더 있었다(런타임
  // 재저장·활성화 토글·아바타·webhook·메시지 정책·프로젝트 접근). canEdit을 한
  // 곳에서 좁혀 전부 읽기 전용으로.
  it('⭐「시스템 발행」— 편집 가능한 것 0(런타임 저장·활성 토글·아바타·webhook·메시지정책·프로젝트접근·키관리·연결설정·실시간연결·런타임카드·알림채널·알림요약)', async () => {
    stubFetch({ agent: { ...AGENT, name: '시스템 발행', runtime_type: 'system-publisher' } });
    await mount();
    expect(container.querySelector('[data-testid="stub-agent-api-key-manager"]')).toBeNull();
    expect(container.querySelector('[data-testid="stub-agent-connection-settings-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="stub-avatar-edit-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="stub-messaging-policy-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-access-projects-count"]')?.getAttribute('data-can-edit')).toBe('false');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '비활성화' || b.textContent === '활성화')).toBe(false);
    // story #3994 CHANGES-4(페드루 PO C4) — 알림 채널 카드 자체가 미렌더되어 그 안의
    // webhook 「저장」 버튼·Switch도 함께 사라진다(런타임 카드도 C3로 미렌더 — 저장
    // 버튼 0개, 웹훅 switch 자체가 DOM에 없음).
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent === '저장').length).toBe(0);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    const notice = container.querySelector('[data-testid="agent-detail-system-publisher-notice"]');
    expect(notice?.textContent).toBe('Sprintable이 자동으로 남기는 알림·기록의 보낸 이예요 — 따로 연결하지 않아도 돼요.');
    // story #3994 CHANGES-3(유나 재앵커 적발) — Fakechat(SSE) 인라인 섹션 미렌더
    // (연결 지시 + amber 거짓 경고 제거, 9번째 차단 자리).
    expect(container.textContent).not.toContain('실시간 연결');
    // story #3994 CHANGES-4(페드루 PO C3/C4) — 런타임 카드(거짓 red unsupported 배지)·
    // 알림 채널·알림 설정 요약 카드(거짓 webhookAdminOnly 사유) 미렌더.
    expect(container.textContent).not.toContain('런타임 타입');
    expect(container.textContent).not.toContain('알림 채널');
    expect(container.textContent).not.toContain('수신 계약 요약');
  });
});

// story #4231 2차 · 까디르 QA(d5b64e7dc) — flat 링크 `?p=`를 싣느라 로드 효과가 프로젝트 전환마다 다시 돌면 안 된다(재fetch 0) ·
// 실패 시 되돌리는 주소는 그 순간의 목표 프로젝트를 싣는다(요청 전에 읽어 둔 옛 값 아님).
describe('AgentDetailPage — 프로젝트 전환과 flat 링크(story #4231)', () => {
  it('⭐프로젝트 전환(전환 대기 목표 변경)에도 에이전트를 다시 받지 않는다(fetch 횟수 불변)', async () => {
    stubFetch();
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const agentCalls = () => fetchMock.mock.calls.filter(([u]) => u === '/api/team-members/agent-1').length;
    const before = agentCalls();
    expect(before).toBeGreaterThan(0);
    const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    await act(async () => { setPendingProjectTarget('proj-B'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(agentCalls()).toBe(before);
    await act(async () => { setPendingProjectTarget(null); });
  });

  it('⭐조회 실패 «목록으로» — 눌린 그 순간의 목표 프로젝트를 싣는다(story 4889: 자동 되돌리기는 없어졌고 같은 규칙이 단추로 옮겨 감)', async () => {
    let resolveAgent!: (v: unknown) => void;
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/team-members/agent-1'
      ? new Promise((r) => { resolveAgent = r; })
      : base(url))));
    await mount();
    const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    await act(async () => { setPendingProjectTarget('proj-B'); });
    await act(async () => { resolveAgent({ ok: false, status: 500, json: async () => null }); await Promise.resolve(); await Promise.resolve(); });
    expect(routerReplaceMock).not.toHaveBeenCalled(); // no silent bounce
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent === '목록으로')!;
    await act(async () => { back.click(); });
    expect(routerPushMock).toHaveBeenCalledWith('/organization/workforce?tab=manage&p=proj-B');
    await act(async () => { setPendingProjectTarget(null); });
  });
});

// story 4889 (AC3 §5 #6) — the agent detail used to bounce to the list WITHOUT A WORD when the read failed, and `if (!agent) return null` could draw a blank page.
// Now the failure is said on the screen with a way out. Reverting either goes red.
describe('AgentDetailPage — 불러오기 실패는 말한다(story 4889 · §5 #6)', () => {
  function stubAgentReply(reply: () => unknown) {
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/team-members/agent-1' ? Promise.resolve(reply()) : base(url))));
  }
  const err = () => container.querySelector('[data-testid="agent-detail-load-error"]');
  const btn = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

  it('⭐404 → «에이전트를 찾을 수 없어요» + [목록으로] — 다시 시도는 없다 · 조용한 되돌리기(router.replace) 없음 · 빈 화면 아님', async () => {
    stubAgentReply(() => ({ ok: false, status: 404, json: async () => null }));
    await mount();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(err()?.getAttribute('data-kind')).toBe('notfound');
    expect(container.textContent).toContain('에이전트를 찾을 수 없어요');
    expect(btn('목록으로')).toBeTruthy();
    expect(btn('다시 시도')).toBeUndefined();
  });

  it('⭐서버 오류(500) → «에이전트를 불러오지 못했어요» + [다시 시도] [목록으로] — [다시 시도]를 누르면 다시 받아 화면이 선다', async () => {
    let ok = false;
    stubAgentReply(() => (ok ? { ok: true, json: async () => ({ data: AGENT }) } : { ok: false, status: 500, json: async () => null }));
    await mount();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(err()?.getAttribute('data-kind')).toBe('failed');
    expect(container.textContent).toContain('에이전트를 불러오지 못했어요');
    expect(btn('다시 시도')).toBeTruthy();
    expect(btn('목록으로')).toBeTruthy();
    ok = true;
    await act(async () => { btn('다시 시도')!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(err()).toBeNull();
    expect(container.textContent).toContain('에이전트1');
  });

  it('⭐네트워크가 끊겨 읽기가 던져도(reject) 같은 «불러오지 못했어요» 상태 — 빈 화면 · 처리 안 된 거절 아님', async () => {
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/team-members/agent-1' ? Promise.reject(new Error('network down')) : base(url))));
    await mount();
    expect(err()?.getAttribute('data-kind')).toBe('failed');
    expect(btn('다시 시도')).toBeTruthy();
  });

  it('읽기가 성공하면 오류 상태는 없다(회귀 0)', async () => {
    stubFetch();
    await mount();
    expect(err()).toBeNull();
    expect(container.textContent).toContain('에이전트1');
  });
});

// story 4889 — one read at a time counts: a new id never shows the OLD agent (while reading or after its read failed), and an older read's late answer does not overwrite the newer page.
describe('AgentDetailPage — id가 바뀔 때(story 4889)', () => {
  const rerender = async () => {
    const { default: AgentDetailPage } = await import('./page');
    await act(async () => { root.render(wrap(<AgentDetailPage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  };

  it('⭐A를 보다가 B로 바뀌어 B의 읽기가 실패하면 A가 남지 않고 오류 상태가 선다 — 되돌리면 빨강', async () => {
    stubFetch(); // agent-1 ok · anything else (agent-2) → not ok
    await mount();
    expect(container.textContent).toContain('에이전트1');
    paramId.current = 'agent-2';
    await rerender();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-detail-load-error"]')?.getAttribute('data-kind')).toBe('failed');
    expect(container.textContent).not.toContain('에이전트1');
  });

  it('⭐옛 id의 늦은 답이 새 id의 화면을 덮지 않는다', async () => {
    let resolveA!: (v: unknown) => void;
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/team-members/agent-1') return new Promise((r) => { resolveA = r; });
      if (url === '/api/team-members/agent-2') return Promise.resolve({ ok: true, json: async () => ({ data: { ...AGENT, id: 'agent-2', name: '에이전트2' } }) });
      return base(url);
    }));
    await mount(); // A pending
    paramId.current = 'agent-2';
    await rerender(); // B answers first
    expect(container.textContent).toContain('에이전트2');
    await act(async () => { resolveA({ ok: true, json: async () => ({ data: AGENT }) }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('에이전트2');
    expect(container.textContent).not.toContain('에이전트1');
  });

  it('⭐옛 id의 답이 먼저 와도 새 id의 로딩을 끝내지 않는다(그 사이 오류 상태 · 옛 화면이 깜빡이지 않는다)', async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/team-members/agent-1') return new Promise((r) => { resolveA = r; });
      if (url === '/api/team-members/agent-2') return new Promise((r) => { resolveB = r; });
      return base(url);
    }));
    await mount(); // A pending
    paramId.current = 'agent-2';
    await rerender(); // B pending too
    await act(async () => { resolveA({ ok: true, json: async () => ({ data: AGENT }) }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-detail-load-error"]')).toBeNull(); // still loading B — not an error, not A
    expect(container.textContent).not.toContain('에이전트1');
    await act(async () => { resolveB({ ok: true, json: async () => ({ data: { ...AGENT, id: 'agent-2', name: '에이전트2' } }) }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('에이전트2');
  });

  it('오류 상태는 알림 역할(role=alert)로 읽힌다', async () => {
    stubFetch();
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/team-members/agent-1' ? Promise.resolve({ ok: false, status: 500, json: async () => null }) : base(url))));
    await mount();
    expect(container.querySelector('[data-testid="agent-detail-load-error"]')?.getAttribute('role')).toBe('alert');
  });
});
