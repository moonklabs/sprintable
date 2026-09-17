// @vitest-environment jsdom
//
// story #4005(BFF `/api/organizations/{id}/members`가 백엔드에 없는 경로로
// 프록시해 404를 catch가 삼켜 담당자 드롭다운이 상시 빈 상태였던 결함) — ③
// 조립 조각. 담당자 후보가 `/api/members`(project_id 생략, org 전원)에서
// 정확히 오는지·「시스템 발행」이 제외되는지·조회 실패 시 빈 드롭다운 대신
// 보이는 오류+「다시 시도」가 뜨는지를 pin한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock, routerPushMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  routerPushMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

import ChannelPostsEngagementPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const ORG_ID = 'org-1';

const EMPTY_ITEMS = { data: { items: [], has_more: false, next_cursor: null }, error: null, meta: null };
const ONE_ITEM = {
  data: {
    items: [{
      id: 'item-1', publication_id: 'pub-1', channel: 'threads', external_comment_id: 'c-1',
      author_display_name: '고객A', text: '언제 배송되나요?', captured_at: '2026-09-17T00:00:00Z',
      triage_status: 'open', assignee_member_id: null, linked_story_id: null, answered_at: null, kind: 'comment',
    }],
    has_more: false, next_cursor: null,
  },
  error: null, meta: null,
};
const EMPTY_COLLECTION = { data: { connections: [] }, error: null, meta: null };

const MEMBERS_OK = {
  data: [
    { id: 'm-1', name: '담롱 온찬', type: 'agent', role: 'member', is_active: true, runtime_type: null },
    { id: 'm-2', name: '페드루 올리베이라', type: 'human', role: 'owner', is_active: true, runtime_type: null },
    // story #3997과 같은 결 — 이 행은 후보에서 제외돼야 한다.
    { id: 'm-3', name: 'Sprintable', type: 'agent', role: 'member', is_active: true, runtime_type: 'system-publisher' },
  ],
  error: null,
  meta: null,
};

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgTimezone: null });
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

function stubFetch(opts: { members?: unknown | { status: number }; items?: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/organizations/${ORG_ID}/engagement/items`)) {
      return { ok: true, status: 200, json: async () => (opts.items ?? EMPTY_ITEMS) };
    }
    if (url === `/api/organizations/${ORG_ID}/engagement/collection-status`) {
      return { ok: true, status: 200, json: async () => EMPTY_COLLECTION };
    }
    if (url === '/api/members') {
      if (opts.members && typeof opts.members === 'object' && 'status' in opts.members) {
        return { ok: false, status: (opts.members as { status: number }).status, json: async () => ({ data: null, error: {} }) };
      }
      return { ok: true, status: 200, json: async () => (opts.members ?? MEMBERS_OK) };
    }
    throw new Error('unexpected fetch: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mount() {
  await act(async () => { root.render(wrap(<ChannelPostsEngagementPage />)); });
  await flush();
}

describe('ChannelPostsEngagementPage — 담당자 후보(story #4005)', () => {
  it('⭐/api/members에서 후보를 받고 「시스템 발행」은 제외한다', async () => {
    stubFetch({ items: ONE_ITEM });
    await mount();
    expect(container.querySelector('[data-testid="engagement-members-retry"]')).toBeNull();

    const select = container.querySelector('[data-testid="engagement-assignee-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const optionTexts = [...select.options].map((o) => o.textContent);
    expect(optionTexts).toContain('담롱 온찬');
    expect(optionTexts).toContain('페드루 올리베이라');
    // story #3997과 같은 결 — 「시스템 발행」(runtime_type='system-publisher')은
    // 배정 후보에서 빠져야 한다(되돌리면(필터 삭제) 이 단언이 RED).
    expect(optionTexts).not.toContain('Sprintable');
    expect(select.options.length).toBe(3); // 「담당 없음」 + 실 후보 2명(3명 中 시스템 발행 1 제외).
  });

  it('⭐members 조회 실패 시 빈 드롭다운이 아니라 오류 문장+「다시 시도」가 뜬다', async () => {
    stubFetch({ members: { status: 500 } });
    await mount();
    const alert = container.querySelector('[data-testid="engagement-members-retry"]');
    expect(alert).not.toBeNull();
    expect(container.textContent).toContain(koMessages.content.engagementAssigneeLoadFailed);
  });

  it('⭐「다시 시도」 클릭 시 재조회하고 성공하면 오류 배너가 사라진다', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/api/organizations/${ORG_ID}/engagement/items`)) {
        return { ok: true, status: 200, json: async () => EMPTY_ITEMS };
      }
      if (url === `/api/organizations/${ORG_ID}/engagement/collection-status`) {
        return { ok: true, status: 200, json: async () => EMPTY_COLLECTION };
      }
      if (url === '/api/members') {
        attempt += 1;
        if (attempt === 1) return { ok: false, status: 500, json: async () => ({ data: null, error: {} }) };
        return { ok: true, status: 200, json: async () => MEMBERS_OK };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    expect(container.querySelector('[data-testid="engagement-members-retry"]')).not.toBeNull();
    const retryButton = container.querySelector('[data-testid="engagement-members-retry"]') as HTMLButtonElement;
    await act(async () => { retryButton.click(); });
    await flush();

    expect(container.querySelector('[data-testid="engagement-members-retry"]')).toBeNull();
    expect(attempt).toBe(2);
  });
});
