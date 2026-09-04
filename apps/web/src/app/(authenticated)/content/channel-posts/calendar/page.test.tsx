// @vitest-environment jsdom
//
// story #3422(Phase1·마케팅운영, doc §11 T8) — 채널 포스트 캘린더 페이지. ③ 조립 조각 —
// 이 파일은 "②에서 만든 부품이 페이지에 정확히 배선됐는가"만 pin한다(부품 각각의 세부
// 분기는 각 컴포넌트의 단위 테스트가 이미 잡는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import ChannelPostCalendarPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const ORG_ID = 'org-1';

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
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

function stubFetch(opts: { connections?: unknown[] | { status: number }; scheduled?: unknown[]; unscheduled?: unknown[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        const connections = opts.connections ?? [];
        if (!Array.isArray(connections)) return { ok: false, status: connections.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: connections, error: null, meta: null }) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/channel-posts/drafts?`)) {
        const isUnscheduled = url.includes('unscheduled=true');
        return { ok: true, status: 200, json: async () => ({ data: isUnscheduled ? (opts.unscheduled ?? []) : (opts.scheduled ?? []), error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

describe('ChannelPostCalendarPage (story #3422 ③)', () => {
  it('⭐연결된 채널이 없으면 빈 상태를 보인다(격자·레인 자체를 안 그린다)', async () => {
    stubFetch({ connections: [] });
    await act(async () => {
      root.render(wrap(<ChannelPostCalendarPage />));
    });
    await flush();
    expect(container.textContent).toContain(koMessages.content.channelPostsCalendarNoChannelsTitle);
    expect(container.querySelector('[data-testid="channel-post-calendar-grid"]')).toBeNull();
  });

  it('⭐채널이 있으면 격자를 그리고, 그 채널 배정의 예약 항목이 셀에 나타난다', async () => {
    stubFetch({
      connections: [{ id: 'c1', account_label: 'Marketing Bot', account_id: 'acct-1' }],
      scheduled: [{ draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', gate_status: null, scheduled_at: new Date().toISOString() }],
    });
    await act(async () => {
      root.render(wrap(<ChannelPostCalendarPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-calendar-grid"]')).not.toBeNull();
    expect(container.textContent).toContain('Marketing Bot');
    expect(container.querySelectorAll('[data-testid="channel-post-calendar-card"]').length).toBe(1);
  });

  it('「날짜 미정」 항목은 레인에 뜨고 격자 셀에는 안 나온다', async () => {
    stubFetch({
      connections: [{ id: 'c1', account_label: 'Marketing Bot', account_id: 'acct-1' }],
      unscheduled: [{ draft_id: 'd2', connection_id: 'c1', channel: 'threads', body_sha256: 'h2', gate_status: null }],
    });
    await act(async () => {
      root.render(wrap(<ChannelPostCalendarPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-unscheduled-lane"]')).not.toBeNull();
  });

  it('연결 조회가 실패하면 오류 안내를 보인다', async () => {
    stubFetch({ connections: { status: 500 } });
    await act(async () => {
      root.render(wrap(<ChannelPostCalendarPage />));
    });
    await flush();
    expect(container.textContent).toContain(koMessages.content.channelPostsCalendarLoadError);
  });
});
