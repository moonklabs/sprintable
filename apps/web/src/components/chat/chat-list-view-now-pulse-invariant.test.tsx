// @vitest-environment jsdom
//
// story #3178(S3b) AC2 — 합산 불변식(「지금」 스트립 + pulse 카드가 동시에 첫 화면을 먹지
// 않는다·최대 1 expand). 각 컴포넌트 단위테스트(now-strip.test.tsx·pulse-card.test.tsx)는
// controlled prop 배선만 잰다 — 이 파일은 실제 ChatListView 안에서 둘이 "서로를 접는지"
// 통합으로 확認한다(전용 파일 — 기존 chat-list-view.test.tsx는 fetchWithAuth를 의도적으로
// 안 목하는 관례라 여기 새로 분리).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';

const { useDashboardContextMock, fetchWithAuthMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(() => ({ role: 'member' })),
  fetchWithAuthMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => {} }));
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/dashboard/my-actions')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            action_queue: { scope: 'org', items: [] },
            attention: {
              scope: 'org',
              items: [{
                type: 'agent_auth_failure', severity: 'danger', auto_detected: true,
                member_id: 'm-1', reason: 'revoked', failure_count: 1, first_failed_at: null, last_failed_at: null,
              }],
              pending: [],
            },
            is_clear: false,
          },
        }),
      };
    }
    if (url.includes('/api/dashboard/overview')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            scope: 'project',
            fleet: { total_agents: 0, status_breakdown: { status: 'pending_data' } },
            project_status: {
              epics: [{ epic_id: 'e1', title: '결제 ②-B', status: 'active', total: 10, done: 6, completion_pct: 60 }],
              outcome: { hit: 0, total: 0 }, recent_changes: [],
              risk: { status: 'pending_data' }, cycle_time: { status: 'pending_data' },
              contribution: { status: 'pending_data' }, cost_trend: { status: 'pending_data' },
            },
          },
        }),
      };
    }
    // conversations 등 이 테스트 관심사 밖 호출 — 빈 목록으로.
    return { ok: true, json: async () => ({ data: [], total: 0 }) };
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ChatListView — S3a 스트립 + S3b pulse 카드 합산 불변식(최대 1 expand)', () => {
  it('스트립을 펼치면 pulse는 collapsed 그대로다', async () => {
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-1" currentTeamMemberId="me-1" />)); });
    await flush();
    const headers = Array.from(container.querySelectorAll('button[aria-expanded]'));
    expect(headers).toHaveLength(2); // 스트립 헤더 + pulse 헤더.
    const stripHeader = headers.find((h) => h.textContent?.includes('지금'))!;
    const pulseHeader = headers.find((h) => h.textContent?.includes('프로젝트 맥박'))!;
    await act(async () => { stripHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(stripHeader.getAttribute('aria-expanded')).toBe('true');
    expect(pulseHeader.getAttribute('aria-expanded')).toBe('false');
  });

  it('스트립이 펼쳐진 상태에서 pulse를 누르면 스트립이 자동으로 접히고 pulse만 펼쳐진다', async () => {
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-1" currentTeamMemberId="me-1" />)); });
    await flush();
    const headers = Array.from(container.querySelectorAll('button[aria-expanded]'));
    const stripHeader = headers.find((h) => h.textContent?.includes('지금'))!;
    const pulseHeader = headers.find((h) => h.textContent?.includes('프로젝트 맥박'))!;

    await act(async () => { stripHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(stripHeader.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { pulseHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pulseHeader.getAttribute('aria-expanded')).toBe('true');
    expect(stripHeader.getAttribute('aria-expanded')).toBe('false'); // 자동 접힘 — 합산 불변식 핵심.
  });

  it('기본 상태(마운트 직후)는 둘 다 collapsed — 첫 화면 두 줄만 점유', async () => {
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-1" currentTeamMemberId="me-1" />)); });
    await flush();
    const headers = Array.from(container.querySelectorAll('button[aria-expanded]'));
    expect(headers.every((h) => h.getAttribute('aria-expanded') === 'false')).toBe(true);
  });
});
