// @vitest-environment jsdom
//
// story #3680(Trust·workforce 실행 목록, 페드루 PO 確定 2026-09-07) — 그라운딩에서
// 밝혀진 진짜 근본원인: 이 컴포넌트가 project_id를 «전혀» 안 보내고 있었다(git log
// 전체에 이 필드가 있었던 적이 없음). BE list_agent_runs는 project_id를 Query(...)
// 필수로 요구해 매 요청이 422였고, 옛 fetchRuns의 `if (!res.ok) return 빈 목록`이
// 그 422를 조용히 "실행 없음"으로 위장시켰다(날짜 범위와 무관하게 항상 0행).
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

import { AgentRunsList } from './agent-runs-list';

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

function stubFetch(handler: (url: URL) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test');
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }));
}

describe('AgentRunsList — project_id 배선(story #3680 근본원인)', () => {
  it('요청 쿼리에 project_id가 실린다(옛 결함=전혀 안 실림)', async () => {
    let capturedUrl: URL | null = null;
    stubFetch((url) => {
      capturedUrl = url;
      return { status: 200, body: { data: [], meta: null } };
    });
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.searchParams.get('project_id')).toBe(PROJECT_ID);
  });

  it('projectId가 아직 없으면(대시보드 컨텍스트 로드 中) 요청을 미루고 로딩 상태를 유지한다', async () => {
    useDashboardContextMock.mockReturnValue({ projectId: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('statusFilter=all이면 status 쿼리 자체를 안 보낸다(normalizeRunStatusFilter 적용 — 옛 결함은 raw statusFilter를 그대로 보내 status=all이 새 BE Literal 422에 걸렸을 것)', async () => {
    let capturedUrl: URL | null = null;
    stubFetch((url) => {
      capturedUrl = url;
      return { status: 200, body: { data: [], meta: null } };
    });
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    const allButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === koMessages.agentRuns.filterAll);
    expect(allButton).toBeDefined();
    await act(async () => { allButton!.click(); });
    await flush();

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.searchParams.has('status')).toBe(false);
  });
});

describe('AgentRunsList — 실패≠0건(story #3680 페드루 PO 지시)', () => {
  it('BE가 422(예: project_id 문제)를 내면 에러 상태를 보이고 빈 목록으로 위장하지 않는다', async () => {
    stubFetch(() => ({ status: 422, body: { data: null, error: { code: 'BAD_REQUEST' } } }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.common.error);
    expect(container.textContent).not.toContain(koMessages.agentRuns.emptyTitle);
    expect(container.textContent).not.toContain(koMessages.agentRuns.emptyTitleDefaultWindow.replace('{days}', '7'));
  });

  it('진짜 0건(200, 빈 배열)이면 에러 상태가 아니라 빈 상태를 보인다', async () => {
    stubFetch(() => ({ status: 200, body: { data: [], meta: null } }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(container.textContent).not.toContain(koMessages.common.error);
    expect(container.textContent).toContain('7');
  });

  it('뮤테이션 — non-ok를 다시 조용히 빈 목록으로 삼키면(옛 사각지대 재현) 에러 상태가 사라지고 빈 상태로 위장되는 것을 고정한다', async () => {
    stubFetch(() => ({ status: 422, body: { data: null, error: { code: 'BAD_REQUEST' } } }));
    const originalFetch = (globalThis as { fetch: typeof fetch }).fetch;
    const swallowingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await originalFetch(input, init);
      // 옛 결함 재현: non-ok를 여기서 삼켜 ok:true·빈 데이터로 위장.
      return { ...res, ok: true, status: 200, json: async () => ({ data: [], meta: null }) } as Response;
    };
    vi.stubGlobal('fetch', swallowingFetch);

    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(container.textContent).not.toContain(koMessages.common.error);
    expect(container.textContent).toContain('7'); // RED가 원래 목표(에러가 사라졌다) — 이 assert가 통과하면 회귀 재현 확認.
  });
});

describe('AgentRunsList — 빈 상태 문구가 기본 창과 넓힌 창을 가른다(story #3680 AC3)', () => {
  it('기본 창(건드리지 않음)에서 0건이면 「최근 N일 실행 없음」 문구', async () => {
    stubFetch(() => ({ status: 200, body: { data: [], meta: null } }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.agentRuns.emptyTitleDefaultWindow.replace('{days}', '7'));
  });

  it('날짜 범위를 넓힌 뒤 0건이면 일반 문구(기본 창 문구 아님)', async () => {
    stubFetch(() => ({ status: 200, body: { data: [], meta: null } }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();

    const fromInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(fromInput).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(fromInput, '2026-06-01');
      fromInput.dispatchEvent(new Event('input', { bubbles: true }));
      fromInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.agentRuns.emptyTitle);
    expect(container.textContent).not.toContain(koMessages.agentRuns.emptyTitleDefaultWindow.replace('{days}', '7'));
  });
});
