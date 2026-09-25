// @vitest-environment jsdom
// story #4302(유나 판정) — 알림 묶음 수는 불러온 쪽 안의 수다(전체 아님). 더 불러올 쪽이 남았으면 «N+건» · 다 불러왔으면 «N건».
// 예전엔 «더 보기»마다 48 → 93 → 143으로 늘어 전체처럼 읽혔다(민 기기 배포 28).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const generic = (id: string) => ({ id, org_id: 'o1', user_id: 'u1', type: 'gate_pending', title: '결재 대기 중인 게이트가 있어요', body: null, is_read: false, reference_type: null, reference_id: null, created_at: '2026-01-01T00:00:00+00:00' });
const statusChange = (id: string) => ({ id, org_id: 'o1', user_id: 'u1', type: 'story_status_changed', title: '상태 변경', body: null, is_read: false, reference_type: 'story', reference_id: 'st-1', href: null, created_at: '2026-01-01T00:00:00+00:00' });

function stubPage(items: unknown[], hasMore: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/notifications')) {
      return { ok: true, status: 200, json: async () => ({ data: items, meta: { unreadCount: items.length, hasMore, nextCursor: hasMore ? 'c1' : null } }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }));
}

async function mount() {
  const { default: InboxPage } = await import('./page');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><InboxPage /></TopBarProvider></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('알림 묶음 수 — 불러온 쪽 기준임을 드러냄(story #4302)', () => {
  it('⭐더 불러올 쪽이 남았으면 반복 알림 묶음 «3+건» · 상태 변경 묶음 «3+회 변경»', async () => {
    stubPage([generic('g1'), generic('g2'), generic('g3'), statusChange('s1'), statusChange('s2'), statusChange('s3')], true);
    await mount();
    expect(container.textContent).toContain('3+건');
    expect(container.textContent).toContain('3+회 변경');
  });

  it('다 불러왔으면 맨 수 «3건» · «3회 변경»(`+` 없음)', async () => {
    stubPage([generic('g1'), generic('g2'), generic('g3'), statusChange('s1'), statusChange('s2'), statusChange('s3')], false);
    await mount();
    expect(container.textContent).toContain('3건');
    expect(container.textContent).toContain('3회 변경');
    expect(container.textContent).not.toContain('3+');
  });
});

// story #4302(까디르 델타 · 빈자리 채움) — «더 보기»로 끝까지 불러오면 묶음 라벨이 «N+»에서 맨 수로 바뀌는 전환.
describe('알림 묶음 수 — «더 보기»로 끝까지 오면 맨 수로 전환(story #4302)', () => {
  it('⭐첫 쪽 «3+건»(더 남음) → «더 보기»로 마지막 쪽(1건 · 더 없음) → «4건»', async () => {
    const pages = [
      { data: [generic('g1'), generic('g2'), generic('g3')], meta: { unreadCount: 4, hasMore: true, nextCursor: 'c1' } },
      { data: [generic('g4')], meta: { unreadCount: 4, hasMore: false, nextCursor: null } },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/notifications')) {
        const page = url.includes('cursor=c1') ? pages[1]! : pages[0]!;
        return { ok: true, status: 200, json: async () => page };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }));
    await mount();
    expect(container.textContent).toContain('3+건');
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.loadMore)!;
    await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(container.textContent).toContain('4건');
    expect(container.textContent).not.toContain('+건');
  });
});

