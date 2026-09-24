// @vitest-environment jsdom
// 유나 10:32Z(4623 · 4612 합류) — story 주소가 이미 `?p=`를 싣고 오는 모양(4612: getEntityHref의 story가 withProject를 쓴다)에서도
// 채팅 카드 «스토리 보기»는 이벤트 프로젝트를 싣는다. 4612 모양을 이 파일에서만 흉내 낸다(다른 테스트에 번지지 않게).
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/chat/embed-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/chat/embed-card')>();
  return {
    ...actual,
    getEntityHref: (type: string, id: string, withProject: (href: string) => string) => (
      type === 'story' ? withProject(`/board?story=${id}`) : actual.getEntityHref(type, id, withProject)
    ),
  };
});

import { EventBlockCard } from './event-block-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('EventBlockCard «스토리 보기» — story 주소가 이미 p를 싣는 모양(4612)', () => {
  it('화면 B · 이벤트 프로젝트 C → p=C(보는 화면 p=B로 착지하지 않는다)', async () => {
    useDashboardContextMock.mockReturnValue({
      currentMemberType: 'human', role: 'admin', orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'proj-B',
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EventBlockCard
            template={{ blocks: [{ type: 'header', text: '헤더' }] }}
            payload={{ stage: 'assign_step_1', work_item_type: 'story', work_item_id: 'story-9' }}
            refs={{ stage_assignee: 'me-1', project_id: 'proj-C' }}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const href = container.querySelector('[data-testid="event-card-view-story"]')?.getAttribute('href') ?? '';
    expect(href).toContain('p=proj-C');
    expect(href).not.toContain('p=proj-B');
  });
});
