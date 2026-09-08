// @vitest-environment jsdom
//
// story #3689(3680 후속) — agent-runs-list.tsx·agent-run-detail.tsx가 각자 status→
// variant 맵을 들고 있던 것을 apps/web/src/lib/agent-run-status.ts 카탈로그 한 자리로
// 합쳤다. 이 테스트는 "두 화면이 실제로 그 카탈로그를 읽는지"를 증명한다(뮤테이션
// 대용) — 카탈로그 모듈을 몽키패치해 abandoned 변이를 실측값(warning)과 다른 값
// (info)으로 바꾸면, list·detail 둘 다 그 새 값을 그대로 반영해야 한다. 반영이 안
// 되면 어느 화면이 여전히 자기 맵을 하드코딩하고 있다는 뜻.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// 실 카탈로그 대신 abandoned=info로 몽키패치(실측 warning과 다른 값 — 두 화면이
// 이 값을 그대로 보이면 카탈로그를 실제로 참조한다는 뜻).
vi.mock('@/lib/agent-run-status', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-run-status')>('@/lib/agent-run-status');
  return {
    ...actual,
    agentRunStatusBadgeVariant: (status: string) => (status === 'abandoned' ? 'info' : actual.agentRunStatusBadgeVariant(status)),
  };
});

import { AgentRunsList } from './agent-runs-list';
import { AgentRunDetail } from './agent-run-detail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

const PROJECT_ID = 'proj-1';

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: PROJECT_ID });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ABANDONED_RUN_ROW = {
  id: 'run-abandoned-1', agent_id: 'agent-1', agent_name: '테스트 에이전트', deployment_id: null,
  session_id: null, memo_id: null, story_id: null, trigger: 'manual', model: null,
  llm_provider: null, llm_provider_key: null, status: 'abandoned', duration_ms: 1000,
  llm_call_count: 1, input_tokens: null, output_tokens: null, cost_usd: null,
  computed_cost_cents: 0, per_run_cap_cents: null, billing_notes: [],
  result_summary: null, error_message: null, last_error_code: null,
  retry_count: null, max_retries: null, next_retry_at: null, failure_disposition: null,
  started_at: null, finished_at: null, created_at: '2026-09-08T00:00:00Z',
};

describe('agent-run-status 카탈로그 배선(story #3689) — list·detail 공유 확인', () => {
  it('AgentRunsList가 카탈로그의 abandoned 변이를 그대로 배지 클래스에 반영한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ data: [ABANDONED_RUN_ROW], meta: null }),
    })));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    const badge = [...container.querySelectorAll('span, div')].find((el) => el.textContent === koMessages.agentRuns.status_abandoned);
    expect(badge).toBeDefined();
    expect(badge?.className).toContain('bg-info-tint');
    expect(badge?.className).not.toContain('bg-warning-tint');
  });

  it('AgentRunDetail이 카탈로그의 abandoned 변이를 그대로 배지 클래스에 반영한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ data: ABANDONED_RUN_ROW }),
    })));
    await act(async () => {
      root.render(wrap(<AgentRunDetail runId="run-abandoned-1" locale="ko" onBack={() => {}} />));
    });
    await flush();

    const badge = [...container.querySelectorAll('span, div')].find((el) => el.textContent === koMessages.agentRuns.status_abandoned);
    expect(badge).toBeDefined();
    expect(badge?.className).toContain('bg-info-tint');
    expect(badge?.className).not.toContain('bg-warning-tint');
  });
});
