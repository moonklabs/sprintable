// @vitest-environment jsdom
// story #4241 — 「오늘」(org-briefing · 조직 전체 목록) 결정 행 링크: 게이트 상세는 결재 자신의 프로젝트(`?p=`) ·
// 결재함 큐(hitl·workflow_step)는 현재 프로젝트 · 프로젝트를 모르는 게이트는 현재 프로젝트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { TodayNeedsMeItem } from './derive-today';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = { projectId: 'proj-A' as string | undefined };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

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

function item(over: Partial<TodayNeedsMeItem>): TodayNeedsMeItem {
  return {
    id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'story', workItemId: 's1',
    workItemTitle: '제목', requestedByName: null, reason: null, createdAt: '2026-09-24T00:00:00Z',
    conversationId: null, recipePublish: false, projectId: null, ...over,
  };
}

async function hrefsFor(items: TodayNeedsMeItem[]): Promise<string[]> {
  const { NeedsMeSection } = await import('./today-sections');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <NeedsMeSection items={items} count={items.length} />
      </NextIntlClientProvider>,
    );
  });
  return [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}

describe('「오늘」 결정 행 링크(story #4241)', () => {
  it.each([
    ['다른 프로젝트 결재 → 그 결재의 프로젝트', item({ id: 'g-c', projectId: 'proj-C' }), '/gates/g-c?p=proj-C'],
    ['같은 프로젝트 결재 → 지금과 같음', item({ id: 'g-a', projectId: 'proj-A' }), '/gates/g-a?p=proj-A'],
    ['프로젝트 모르는 결재 → 현재 프로젝트', item({ id: 'g-x', projectId: null }), '/gates/g-x?p=proj-A'],
    ['결재함 큐(hitl) → 현재 프로젝트', item({ id: 'h1', source: 'hitl', state: 'answer', projectId: 'proj-C' }), '/inbox?tab=gates&p=proj-A'],
  ])('%s', async (_label, it1, expected) => {
    expect(await hrefsFor([it1])).toContain(expected);
  });
});
