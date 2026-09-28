// @vitest-environment jsdom
// [SID:4311 PR 2] 대시보드 최근 활동 줄의 행위자 — 같은 이름 서로 다른 구성원 둘이면 «· ID 앞 8자»(actor_id마다 한 번 · 시스템 행 제외 ·
// 머리글자 그대로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DashboardActivityTimeline } from './dashboard-activity-timeline';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const row = (id: string, actor_id: string | null, actor_name: string | null) => ({
  id, actor_id, actor_name, actor_type: actor_id ? 'human' : null, action: 'story.created', entity_type: 'story', entity_title: `일감 ${id}`,
  context: null, created_at: '2026-09-26T00:00:00Z',
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  fetchWithAuthMock.mockReset();
});

async function mount(items: unknown[]) {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: { items } }) });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DashboardActivityTimeline projectId="p1" />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('DashboardActivityTimeline — 행위자 동명이인([SID:4311 PR 2])', () => {
  it('«송윤재» 둘(서로 다른 id)은 «· ID 앞 8자» · 같은 사람 여러 줄은 겹침 아님 · 시스템 행 문구 그대로 · 머리글자 그대로', async () => {
    await mount([
      row('r1', 'e75ca548-1', '송윤재'),
      row('r2', '2fd14616-2', '송윤재'),
      row('r3', 'm-anna', '안나'),
      row('r4', 'm-anna', '안나'),
      row('r5', null, null),
    ]);
    const actors = [...container.querySelectorAll('span.font-medium')].map((el) => el.textContent);
    expect(actors).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '안나', '안나', koMessages.activityTimeline.unknownActor]);
    const badges = [...container.querySelectorAll('span[aria-hidden="true"]')].map((el) => el.textContent);
    expect(badges.slice(0, 2)).toEqual(['송윤재'.slice(0, 1).toUpperCase(), '송윤재'.slice(0, 1).toUpperCase()]);
  });
});
