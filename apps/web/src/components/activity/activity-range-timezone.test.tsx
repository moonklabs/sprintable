// @vitest-environment jsdom
// story #4280(민 기기 · 배포 27) — 활동 로그 · 팀 활동의 기본 기간이 `toISOString().slice(0, 10)`(UTC 날짜)라 KST 00~09시에 끝 날짜가
// «어제»였다(9/25 02:49 KST에 «~ 9. 24.»). 그리고 날짜 칸 값을 오프셋 없는 `…T00:00:00`으로 보내 BE가 UTC로 읽었다(KST 첫날 00~09시 누락).
// 두 화면 모두 표시 시간대(조직 timezone) 기준 «오늘»과 그 시간대의 자정 · 자정 직전으로 조회하는지 실 렌더로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import enMessages from '../../../messages/en.json';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

let orgTimezone: string | null = 'Asia/Seoul';
vi.mock('@/app/dashboard/dashboard-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/dashboard/dashboard-shell')>();
  return { ...actual, useDashboardContext: () => ({ ...actual.useDashboardContext(), orgTimezone }) };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// 민 기기 실측 시각 — 2026-09-25 02:49 KST = 2026-09-24 17:49 UTC.
const DEVICE_NOW = new Date('2026-09-24T17:49:00Z');

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TopBarProvider>{node}</TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

function dateInputValues(): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]')).map((i) => i.value);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(DEVICE_NOW);
  orgTimezone = 'Asia/Seoul';
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/activity-stream')) return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0, limit: 30, offset: 0 } }) };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
});

describe('활동 로그 기본 기간 — 표시 시간대의 오늘(story #4280)', () => {
  it('⭐KST 02:49: 날짜 칸 9/18 ~ 9/25 · 조회 경계 = KST 자정 · 자정 직전(오프셋 있는 UTC)', async () => {
    const { ActivityLogView } = await import('./activity-log-view');
    await render(<ActivityLogView projectId="p1" />);
    expect(dateInputValues()).toEqual(['2026-09-18', '2026-09-25']);
    const call = fetchWithAuthMock.mock.calls.map(([u]: [string]) => u).find((u) => u.includes('/api/activity-logs'));
    expect(call).toBeDefined();
    const params = new URL(call!, 'http://x').searchParams;
    expect(params.get('from')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('to')).toBe('2026-09-25T14:59:59.999Z');
  });

  it('조직 timezone이 UTC면 UTC 날짜(같은 순간 · 9/24)', async () => {
    orgTimezone = 'UTC';
    const { ActivityLogView } = await import('./activity-log-view');
    await render(<ActivityLogView projectId="p1" />);
    expect(dateInputValues()).toEqual(['2026-09-17', '2026-09-24']);
  });
});

describe('팀 활동 기본 기간 — 표시 시간대의 오늘(story #4280)', () => {
  it('⭐KST 02:49: 날짜 칸 끝 = 9/25 · 조회 until = KST 9/25 23:59:59.999', async () => {
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    expect(dateInputValues()).toEqual(['2026-09-18', '2026-09-25']);
    const call = fetchWithAuthMock.mock.calls.map(([u]: [string]) => u).find((u) => u.includes('/api/activity-stream'));
    expect(call).toBeDefined();
    const params = new URL(call!, 'http://x').searchParams;
    expect(params.get('since')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('until')).toBe('2026-09-25T14:59:59.999Z');
  });
});
