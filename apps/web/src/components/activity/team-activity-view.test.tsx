// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// 이 컴포넌트엔 아직 전용 렌더 테스트가 없어 h1 불변식 확인 목적으로 새로 둔다
// (activity-log-view.test.tsx와 동형 관례).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TeamActivityView } from './team-activity-view';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

let container: HTMLDivElement;
let root: Root;

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TopBarTitleProbe />
          <TeamActivityView projectId="p1" />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/activity-stream')) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [], next_after_seq: null } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('TeamActivityView — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목)', async () => {
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
