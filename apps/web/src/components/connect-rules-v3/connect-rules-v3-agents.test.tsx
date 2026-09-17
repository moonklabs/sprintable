// @vitest-environment jsdom
//
// story #3982 §(c) 연결된 에이전트 — 3상태(로딩·빈·오류)와 「사라짐 0」(verified=false
// 행도 사라지지 않고 배지로 남는다·「에이전트 추가」 링크는 항상 렌더·행 펼침엔 항상
// 「연결 설정 보기」가 있다) 고정. PO CHANGES-4 반영 — 역할은 agent_role(실데이터는
// null이 흔함)+runtime_type 조합, 지어낸 roleLabel* 없음.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { ConnectRulesV3Agents } = await import('./connect-rules-v3-agents');
  await act(async () => { root.render(wrap(<ConnectRulesV3Agents />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function routeFetch(map: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [prefix, payload] of Object.entries(map)) {
      if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('ConnectRulesV3Agents', () => {
  it('⭐빈 상태 — 에이전트 0건이어도 「에이전트 추가」 링크는 사라지지 않는다', async () => {
    routeFetch({
      '/api/team-members?type=agent': { data: [] },
      '/api/me': { data: { role: 'owner' } },
      '/api/projects': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('아직 연결된 에이전트가 없어요');
    expect(container.querySelector('[data-testid="connect-rules-v3-add-agent-link"]')).not.toBeNull();
  });

  it('오류 — 「다시 시도」 버튼이 보인다', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
    expect(container.querySelector('button')?.textContent).toContain('다시 시도');
  });

  it('⭐verified=false 행 — 사라지지 않고 「연결 안 됨」 배지로 남는다(사라짐 0)', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a1', name: '유나 홀름', agent_role: null, runtime_type: null, is_active: true, verified: false, presence_status: 'offline', project_id: null }],
      },
      '/api/me': { data: { role: 'owner' } },
      '/api/projects': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('유나 홀름');
    expect(container.textContent).toContain('연결 안 됨');
  });

  it('⭐dev 실측 형태(agent_role=null) — 역할 세그먼트를 지어내지 않고 이름·상태만 렌더', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a2', name: '디디 은두카쿠', agent_role: null, runtime_type: null, is_active: true, verified: true, presence_status: 'online', project_id: 'p1' }],
      },
      '/api/me': { data: { role: 'member' } },
      '/api/projects': { data: [{ id: 'p1', name: 'Sprintable' }] },
    });
    await mount();
    expect(container.textContent).toContain('디디 은두카쿠');
    expect(container.textContent).toContain('연결됨');
    expect(container.textContent).toContain('온라인');
  });

  it('⭐runtime_type 등록키 — runtime-capabilities 레지스트리 표시명으로 렌더(raw key 노출 0)', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a4', name: '유나 홀름', agent_role: 'UI Designer', runtime_type: 'claude-code', is_active: true, verified: true, presence_status: 'idle', project_id: null }],
      },
      '/api/me': { data: { role: 'member' } },
      '/api/projects': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('UI Designer · Claude Code');
    expect(container.textContent).not.toContain('claude-code');
  });

  it('⭐runtime_type 미등재값 — 라벨 생략(원값 「보존」 안 함, story #3103 규율)', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a6', name: '담롱 온찬', agent_role: 'Growth Hacker', runtime_type: 'internal-beta', is_active: true, verified: true, presence_status: 'idle', project_id: null }],
      },
      '/api/me': { data: { role: 'member' } },
      '/api/projects': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('Growth Hacker');
    expect(container.textContent).not.toContain('internal-beta');
  });

  it('runtime_type null — role만(구분자 없이)', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a7', name: '카디르 아흐마디', agent_role: 'QA Engineer', runtime_type: null, is_active: true, verified: true, presence_status: 'idle', project_id: null }],
      },
      '/api/me': { data: { role: 'member' } },
      '/api/projects': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('QA Engineer');
    expect(container.textContent).not.toContain('QA Engineer ·');
  });

  it('⭐행 펼침 — 항상 「연결 설정 보기」가 있고, project_id가 있으면 agent-stats·프로젝트 이름을 낸다', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a3', name: '카디르 아흐마디', agent_role: null, runtime_type: null, is_active: true, verified: true, presence_status: 'idle', project_id: 'p9' }],
      },
      '/api/me': { data: { role: 'owner' } },
      '/api/projects': { data: [{ id: 'p9', name: 'Sprintable' }] },
      '/api/agents/access-matrix': { data: [{ agent_member_id: 'a3', project_id: 'p9', record_id: 'r1' }] },
      '/api/analytics/agent-stats': { data: { completed: 4, total_stories: 5, done_story_points: 8, avg_lead_time_ms: 2 * 24 * 60 * 60 * 1000 } },
    });
    await mount();
    const row = container.querySelector('[data-testid="connect-rules-v3-agent-row"] button') as HTMLButtonElement;
    const before = fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/analytics/agent-stats')).length;
    expect(before).toBe(0);
    await act(async () => { row.click(); await Promise.resolve(); await Promise.resolve(); });
    const after = fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/analytics/agent-stats')).length;
    expect(after).toBe(1);
    expect(container.textContent).toContain('연결 설정 보기');
    expect(container.textContent).toContain('완료 4건');
    expect(container.textContent).toContain('Sprintable 기준');
    expect(container.textContent).toContain('프로젝트 1개 접근 허용');
  });

  it('⭐비관리자 — 접근 권한 칸 자체가 없다(안내 문장 0, 칸째 제거)', async () => {
    routeFetch({
      '/api/team-members?type=agent': {
        data: [{ id: 'a5', name: '담롱 온찬', agent_role: null, runtime_type: null, is_active: true, verified: true, presence_status: 'offline', project_id: null }],
      },
      '/api/me': { data: { role: 'member' } },
      '/api/projects': { data: [] },
    });
    await mount();
    const row = container.querySelector('[data-testid="connect-rules-v3-agent-row"] button') as HTMLButtonElement;
    await act(async () => { row.click(); });
    expect(container.textContent).not.toContain('접근');
  });
});
