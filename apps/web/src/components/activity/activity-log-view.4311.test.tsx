// @vitest-environment jsdom
// [SID:4311 PR 2] 활동 피드 행의 행위자 — 같은 이름 서로 다른 구성원 둘이면 «· ID 앞 8자»로 갈린다(유나: actor_id마다 한 번 · 시스템 행 제외 ·
// 머리글자 그대로). 감사 밀도 행은 이름을 아바타 접근성 이름(aria-label)으로만 싣는다 → 그 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import { initials } from '@/lib/storage/format';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const row = (id: string, actor_id: string | null, actor_name: string | null) => ({
  id, actor_id, actor_name, actor_type: actor_id ? 'human' : null, action: 'story.updated', entity_type: 'story', entity_title: `일감 ${id}`,
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
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ data: { items, total: items.length, limit: 50, offset: 0 } }) };
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <ActivityLogView projectId="p1" />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

const actorNames = () => [...container.querySelectorAll('[aria-label]')]
  .map((el) => el.getAttribute('aria-label') ?? '')
  .filter((label) => label.includes('송윤재') || label.includes('안나') || label.includes(koMessages.common.memberUnnamed));

describe('ActivityLogView — 행위자 동명이인([SID:4311 PR 2])', () => {
  it('«송윤재» 둘(서로 다른 id)은 줄마다 «· ID 앞 8자» · 같은 사람이 여러 줄이어도 겹침 아님 · 시스템 행은 빈 슬롯', async () => {
    await mount([
      row('r1', 'e75ca548-1', '송윤재'),
      row('r2', '2fd14616-2', '송윤재'),
      row('r3', 'e75ca548-1', '송윤재'),
      row('r4', 'm-anna', '안나'),
      row('r5', 'm-anna', '안나'),
      row('r6', null, null),
    ]);
    expect(actorNames()).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '송윤재 · e75ca548', '안나', '안나']);
    // 머리글자는 이름 그대로 — 꼬리 붙은 줄도 꼬리 없는 이름과 같은 머리글자(꼬리 글자가 아바타로 새지 않음).
    const song = [...container.querySelectorAll('[aria-label^="송윤재"]')].map((el) => el.textContent);
    expect(song).toEqual([initials('송윤재'), initials('송윤재'), initials('송윤재')]);
  });

  it('이름 없는 구성원 둘도 같은 꼬리로 갈린다(아바타는 아이콘 그대로)', async () => {
    await mount([row('r1', 'aaaaaaaa-1', null), row('r2', 'bbbbbbbb-2', null), row('r3', 'e75ca548-1', '송윤재')]);
    const unnamed = koMessages.common.memberUnnamed;
    expect(actorNames()).toEqual([`${unnamed} · aaaaaaaa`, `${unnamed} · bbbbbbbb`, '송윤재']);
    expect([...container.querySelectorAll(`[aria-label^="${unnamed}"]`)].map((el) => el.textContent)).toEqual(['', '']);
  });
});
