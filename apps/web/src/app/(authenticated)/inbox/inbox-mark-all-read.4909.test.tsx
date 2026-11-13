// @vitest-environment jsdom
//
// story 4909 (UI-R1 결재함 «후» 판정) — 위 막대의 «전체 읽음»이 옛 ui Button(glass · 옛 미색 247,246,243 / 다크 11,12,13)이었다.
// 이제 ds Button이다: 되돌리면(옛 Button) data-slot이 'button'이 돼 RED. 동작(PATCH {markAllRead:true} · 읽은 뒤 비활성)은 그대로여야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/api/notifications') && init?.method === 'PATCH') return { ok: true, json: async () => ({ ok: true }) };
    if (url.includes('/api/notifications')) return { ok: true, json: async () => ({ data: [], meta: { unreadCount: 7, hasMore: false, nextCursor: null } }) };
    if (url.includes('/api/workflow-executions')) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: false, status: 404, json: async () => null };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function Actions() {
  const { actions } = useTopBar();
  return <div data-testid="actions">{actions}</div>;
}

async function mount() {
  const { default: InboxPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <Actions />
          <InboxPage />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const markAll = () => container.querySelector(`[data-testid="actions"] [aria-label="${koMessages.inbox.markAllRead}"]`) as HTMLElement | null;

describe('결재함 위 막대 «전체 읽음» (4909)', () => {
  it('⭐ds Button이다 — 옛 ui Button(data-slot="button")이 아니다', async () => {
    await mount();
    const btn = markAll();
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('data-slot')).toBe('ds-button');
    expect(container.querySelector('[data-testid="actions"] [data-slot="button"]')).toBeNull();
  });

  it('폰에선 아이콘만(글자 sm 이상) · 접근 이름은 그대로 «전체 읽음»', async () => {
    await mount();
    const btn = markAll()!;
    expect(btn.querySelector('svg.sm\\:hidden')).not.toBeNull();
    expect(btn.querySelector('span.hidden.sm\\:inline')?.textContent).toBe(koMessages.inbox.markAllRead);
  });

  it('동작 그대로 — 안 읽은 게 있으면 눌려서 PATCH {markAllRead:true}를 보내고, 끝나면 비활성이 된다', async () => {
    await mount();
    const btn = markAll() as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.url).toContain('/api/notifications');
    expect(JSON.parse(String(patch!.init!.body))).toEqual({ markAllRead: true });
    expect((markAll() as HTMLButtonElement).disabled).toBe(true);
  });
});
