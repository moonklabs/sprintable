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
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return { ...actual, useToast: () => ({ addToast: addToastMock, toasts: [], dismissToast: () => {} }) };
});
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

  it('⭐시작 날짜를 비우면 오류 없이 과거 경계 없음(since 없음 · 최신부터 커서가 끝까지 잇는다) · 끝까지 비우면 until도 없음', async () => {
    // story #4297 — 4280의 «빈 시작 = 끝 날짜에서 7일 전 창» 지름길은 최신순 커서(order=desc · before_seq)로 대체됐다.
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const [fromInput, toInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    fetchWithAuthMock.mockClear();
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const afterFrom = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(afterFrom.get('order')).toBe('desc');
    expect(afterFrom.get('since')).toBeNull();
    expect(afterFrom.get('until')).toBe('2026-09-25T14:59:59.999Z');
    await act(async () => { setDate(toInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const afterTo = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(afterTo.get('since')).toBeNull();
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

  const ITEM = (seq: number) => ({ activity_id: `a${seq}`, project_id: 'p1', occurred_at: '2026-09-20T00:00:00Z', verb: 'created', object_type: 'story', object_id: 'o1', actor_id: null, source_event_ids: [], recipient_ids: [], recipient_types: [], payload: { title: `item-${seq}` }, activity_seq: seq });
  function stubStream(pages: Record<string, { items: ReturnType<typeof ITEM>[]; next_before_seq: number | null }>) {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        const before = new URL(url, 'http://x').searchParams.get('before_seq') ?? 'first';
        const page = pages[before] ?? { items: [], next_before_seq: null };
        return { ok: true, status: 200, json: async () => ({ data: { items: page.items, next_after_seq: null, next_before_seq: page.next_before_seq } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0 } }) };
    });
  }
  const moreButton = () => Array.from(container.querySelectorAll('button')).find((b) => /load more/i.test(b.textContent ?? ''));

  it('⭐«더 보기»는 같은 기간 경계 안에서 before_seq=서버 커서 · 이어 붙인 목록이 최신 → 과거 순(뒤집지 않음)', async () => {
    stubStream({ first: { items: [ITEM(30), ITEM(20)], next_before_seq: 20 }, '20': { items: [ITEM(10)], next_before_seq: null } });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const firstCall = new URL(streamCalls()[0]!, 'http://x').searchParams;
    expect(firstCall.get('order')).toBe('desc');
    expect(firstCall.get('before_seq')).toBeNull();
    fetchWithAuthMock.mockClear();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const params = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(params.get('before_seq')).toBe('20');
    expect(params.get('since')).toBe('2026-09-17T15:00:00.000Z');
    expect(params.get('until')).toBe('2026-09-25T14:59:59.999Z');
    const text = container.textContent ?? '';
    expect(text.indexOf('item-30')).toBeLessThan(text.indexOf('item-20'));
    expect(text.indexOf('item-20')).toBeLessThan(text.indexOf('item-10'));
    expect(moreButton(), '서버 커서가 null이면 더 보기 없음').toBeUndefined();
  });

  it('⭐시작 날짜를 비워도 서버 커서가 있으면 «더 보기»가 살아 있고 경계 없이 이전 쪽으로(빈 주에서 끝나지 않음)', async () => {
    stubStream({ first: { items: [ITEM(5)], next_before_seq: 5 }, '5': { items: [ITEM(1)], next_before_seq: null } });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    const [fromInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(moreButton(), '빈 시작에서도 더 보기').toBeTruthy();
    fetchWithAuthMock.mockClear();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const params = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(params.get('before_seq')).toBe('5');
    expect(params.get('since')).toBeNull();
    expect(container.textContent).toContain('item-1');
  });

  it('⭐끝까지 오면 끝 문장 — 시작일이 있으면 «이 기간의 활동을 다 봤어요…» · 비우면 «처음 활동까지 다 봤어요.»(유나 판정)', async () => {
    stubStream({ first: { items: [ITEM(3)], next_before_seq: null } });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    expect(container.textContent).toContain(enMessages.teamActivity.endOfRange);
    expect(container.textContent).not.toContain(enMessages.teamActivity.endOfAll);
    const [fromInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toContain(enMessages.teamActivity.endOfAll);
    expect(container.textContent).not.toContain(enMessages.teamActivity.endOfRange);
  });

  it('⭐«더 보기» 실패는 끝이 아니다 — 버튼 그대로 · 끝 문장 없음 · 실패 토스트 한 번', async () => {
    addToastMock.mockClear();
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        if (new URL(url, 'http://x').searchParams.get('before_seq')) return { ok: false, status: 502, json: async () => null };
        return { ok: true, status: 200, json: async () => ({ data: { items: [ITEM(9)], next_after_seq: null, next_before_seq: 9 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0 } }) };
    });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(moreButton()).toBeTruthy();
    expect(container.textContent).not.toContain(enMessages.teamActivity.endOfRange);
    // story #4297(유나 후속 · PO) — 무음 실패가 아니라 토스트 한 번(결재함과 같은 공용 문구).
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith({ title: enMessages.common.loadMoreFailed, type: 'error' });
  });

  it('⭐조건이 바뀐 뒤 늦게 온 «더 보기» 응답은 버린다 — 새 결과에 옛 행 · 옛 커서가 붙지 않음(까디르 판정)', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/activity-stream')) {
        const q = new URL(url, 'http://x').searchParams;
        if (q.get('before_seq') === '20') {
          // 옛 조건의 «더 보기» — 조건이 바뀐 뒤에야 도착한다.
          await new Promise((r) => { releaseOld = r; });
          return { ok: true, status: 200, json: async () => ({ data: { items: [ITEM(10)], next_after_seq: null, next_before_seq: 10 } }) };
        }
        if (q.get('since') === null) {
          return { ok: true, status: 200, json: async () => ({ data: { items: [ITEM(99)], next_after_seq: null, next_before_seq: 99 } }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: { items: [ITEM(30), ITEM(20)], next_after_seq: null, next_before_seq: 20 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0 } }) };
    });
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 옛 «더 보기»가 걸린 사이 시작 날짜를 비운다 → 새 조건으로 첫 쪽을 다시 받는다.
    const [fromInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    await act(async () => { setDate(fromInput!, ''); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toContain('item-99');
    await act(async () => { releaseOld(null); await vi.advanceTimersByTimeAsync(100); });
    expect(container.textContent, '옛 조건의 행이 붙지 않음').not.toContain('item-10');
    fetchWithAuthMock.mockClear();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const next = new URL(streamCalls().pop()!, 'http://x').searchParams;
    expect(next.get('before_seq'), '커서는 새 결과의 것').toBe('99');
  });

  it('첫 쪽이 비어 있고 서버 커서가 없으면 «더 보기»를 그리지 않는다', async () => {
    stubStream({});
    const { TeamActivityView } = await import('./team-activity-view');
    await render(<TeamActivityView projectId="p1" />);
    expect(moreButton()).toBeUndefined();
    expect(container.textContent, '0건은 빈 상태가 맡는다 — 끝 문장 없음').not.toContain(enMessages.teamActivity.endOfRange);
  });
});

