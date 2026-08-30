// @vitest-environment jsdom
// story #3228(버그사냥, 카디르 발견 → 착수) — Activity Log의 action 필터 입력창이
// debounce 없이 buildParams/fetchLogs의 useCallback 의존값이었다. 타이핑 1글자당
// 네트워크 재조회 이펙트가 재실행돼(실측: 50자 타이핑 → /api/activity-logs 요청
// 정확히 50건, 1:1) 긴 문자열을 빠르게 입력하면 수백~수천 건이 몰려 브라우저
// 커넥션풀 고갈(ERR_INSUFFICIENT_RESOURCES) → 비동기 응답들이 거의 동시 귀환하며
// 겹쳐 부르는 setState 폭주가 React #185(Maximum update depth exceeded)로 이어져
// 페이지 전체가 크래시했다. 처방: actionFilter를 300ms debounce한 값으로만
// buildParams가 재계산되도록 분리 + maxLength=200 방어선.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import enMessages from '../../../messages/en.json';

const fetchWithAuthMock = vi.fn();

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TopBarProvider>
          <ActivityLogView projectId="p1" />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0, limit: 30, offset: 0 } }) };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  container.remove();
});

describe('ActivityLogView — action 필터 debounce(story #3228)', () => {
  it('길게 연타 입력해도 activity-logs 요청은 debounce 창 1개로 뭉친다(요청 폭주 방지)', async () => {
    await mount();
    fetchWithAuthMock.mockClear();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    // 뮤테이션 전이면 이만큼 타이핑 시 activity-logs 요청도 그만큼(1:1) 나갔다 —
    // debounce가 살아있으면 실제 fetchLogs 호출은 debounce 창이 만료된 뒤 1건뿐이어야 한다.
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        setInputValue(input, 'A'.repeat(i + 1));
        vi.advanceTimersByTime(10); // 각 keystroke 사이 10ms — 300ms debounce 창보다 훨씬 짧음
      }
    });

    const activityLogCallsDuringTyping = fetchWithAuthMock.mock.calls.filter(([u]: [string]) => u.includes('/api/activity-logs')).length;
    expect(activityLogCallsDuringTyping).toBe(0); // 타이핑 도중엔 아직 debounce 창 안 — 0건이어야 함

    await act(async () => { vi.advanceTimersByTime(350); }); // debounce 창 만료

    const activityLogCallsAfterSettle = fetchWithAuthMock.mock.calls.filter(([u]: [string]) => u.includes('/api/activity-logs')).length;
    expect(activityLogCallsAfterSettle).toBe(1); // 정확히 1건만 — 요청 폭주 재발 시 이 값이 커진다
  });

  it('debounce 만료 후 실제 action 쿼리파라미터가 최종 입력값으로 정확히 나간다(무회귀 — 필터 기능 자체는 정상)', async () => {
    await mount();
    fetchWithAuthMock.mockClear();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'deploy'); });
    await act(async () => { vi.advanceTimersByTime(350); });

    const call = fetchWithAuthMock.mock.calls.find(([u]: [string]) => u.includes('/api/activity-logs'));
    expect(call).toBeDefined();
    const url = new URL(call![0] as string, 'http://x');
    expect(url.searchParams.get('action')).toBe('deploy');
  });

  it('입력값을 지우면(빈 문자열) debounce 후 action 파라미터가 다시 빠진다(무회귀)', async () => {
    await mount();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'deploy'); });
    await act(async () => { vi.advanceTimersByTime(350); });
    fetchWithAuthMock.mockClear();

    await act(async () => { setInputValue(input, ''); });
    await act(async () => { vi.advanceTimersByTime(350); });

    const call = fetchWithAuthMock.mock.calls.find(([u]: [string]) => u.includes('/api/activity-logs'));
    expect(call).toBeDefined();
    const url = new URL(call![0] as string, 'http://x');
    expect(url.searchParams.has('action')).toBe(false);
  });

  it('maxLength=200 방어선 — 입력창이 그 이상은 애초에 못 받도록 정직하게 제한한다(잘라내기 아님, 입력차단)', async () => {
    await mount();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.maxLength).toBe(200);
  });
});
