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
    const call = fetchWithAuthMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/activity-logs'));
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
    const call = fetchWithAuthMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/activity-stream'));
    expect(call).toBeDefined();
    const params = new URL(call!, 'http://x').searchParams;
    expect(params.get('since')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('until')).toBe('2026-09-25T14:59:59.999Z');
  });
});

// story #4280(까디르 검수 P2 · P3) — 날짜 칸을 비우면 경계 null → 예전엔 NaN → toISOString() RangeError로 화면이 깨졌다. «더 보기»는 달력 7일.
describe('팀 활동 — 빈 날짜 칸 · 더 보기(story #4280)', () => {
  function setDate(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const streamCalls = () => fetchWithAuthMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/activity-stream'));

  it('⭐시작 날짜를 비우면 오류 없이 «끝 날짜에서 7일 전 자정»부터 최근 창 · 끝까지 비우면 «지금»에서 7일 전 · until 없음', async () => {
    // BE 활동 스트림은 limit + 오름차순이라 since 없이 부르면 가장 오래된 N개만 온다(최근이 조용히 잘림) — 빈 시작도 최근 창부터.
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const [fromInput, toInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    fetchWithAuthMock.mockClear();
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const afterFrom = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(afterFrom.get('since')).toBe('2026-09-17T15:00:00.000Z'); // 9/25(끝) − 7일 = 9/18 00:00 KST
    expect(afterFrom.get('until')).toBe('2026-09-25T14:59:59.999Z');
    await act(async () => { setDate(toInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const afterTo = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(afterTo.get('since')).toBe('2026-09-17T15:00:00.000Z'); // 지금(9/25 02:49 KST) − 7일 = 9/18 00:00 KST
    expect(afterTo.get('until')).toBeNull();
  });

  it('시작 날짜는 두고 끝 날짜만 비우면 since 그대로 · until 없음', async () => {
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const [, toInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    fetchWithAuthMock.mockClear();
    await act(async () => { setDate(toInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const params = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(params.get('since')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('until')).toBeNull();
  });

  it('«더 보기»는 시작 날짜 자정(KST)에서 달력 7일 전 자정까지', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [{ activity_id: 'a1', project_id: 'p1', occurred_at: '2026-09-20T00:00:00Z', verb: 'created', object_type: 'story', object_id: 'o1', actor_id: null, source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: 1 }] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0 } }) };
    });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const more = Array.from(container.querySelectorAll('button')).find((b) => /load more/i.test(b.textContent ?? ''));
    expect(more, '더 보기 버튼').toBeTruthy();
    fetchWithAuthMock.mockClear();
    await act(async () => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const params = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(params.get('until')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('since')).toBe('2026-09-10T15:00:00.000Z');
  });

  it('⭐시작 날짜를 비워도 «더 보기»가 살아 있고 경계 없이 7일씩 과거로(예전엔 꺼져 최근만 보거나 오래된 N개에 갇힘)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [{ activity_id: `a-${url.length}`, project_id: 'p1', occurred_at: '2026-09-20T00:00:00Z', verb: 'created', object_type: 'story', object_id: 'o1', actor_id: null, source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: 1 }] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0 } }) };
    });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const [fromInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const more = Array.from(container.querySelectorAll('button')).find((b) => /load more/i.test(b.textContent ?? ''));
    expect(more, '빈 시작에서도 더 보기').toBeTruthy();
    fetchWithAuthMock.mockClear();
    await act(async () => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const params = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(params.get('until')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('since')).toBe('2026-09-10T15:00:00.000Z');
  });
});

