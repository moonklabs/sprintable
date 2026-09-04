// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CalendarRangeControls } from './calendar-range-controls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

describe('CalendarRangeControls — story #3422 ②-b 3/N-c', () => {
  it('⭐다음 주 클릭 시 range가 tz 기준 정확히 7일 뒤로 이동한다(날짜 키 산술, B1③)', async () => {
    let called: { from: string; to: string } | null = null;
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.999Z' }}
          onRangeChange={(r) => { called = r; }}
          displayTimezone="UTC"
        />,
      ));
    });
    const next = container.querySelector('[data-testid="channel-post-calendar-range-next"]') as HTMLButtonElement;
    await act(async () => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).toEqual({ from: '2026-09-08T00:00:00.000Z', to: '2026-09-14T23:59:59.999Z' });
  });

  it('⭐이전 주 클릭 시 range가 tz 기준 정확히 7일 앞으로 이동한다', async () => {
    let called: { from: string; to: string } | null = null;
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-08T00:00:00.000Z', to: '2026-09-14T23:59:59.999Z' }}
          onRangeChange={(r) => { called = r; }}
          displayTimezone="UTC"
        />,
      ));
    });
    const prev = container.querySelector('[data-testid="channel-post-calendar-range-prev"]') as HTMLButtonElement;
    await act(async () => {
      prev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.999Z' });
  });

  it('현재 범위를 MM-DD ~ MM-DD로 보인다(UTC)', async () => {
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.999Z' }}
          onRangeChange={() => {}}
          displayTimezone="UTC"
        />,
      ));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-range-label"]')?.textContent).toBe('09-01 ~ 09-07');
  });

  // B1②(페드루 PO 재판정) — 라벨은 ISO slice가 아니라 tz 기준 «열 키»에서 뽑는다. UTC
  // 자정 직전(range.to)이 KST에서는 다음날 아침이라, ISO slice와 toDateKey가 다른
  // 날짜를 내는 경계로 회귀를 잡는다(slice로 되돌리면 이 테스트가 RED가 된다).
  it('⭐B1② — displayTimezone=KST면 라벨이 ISO slice가 아니라 tz 기준 날짜 키에서 나온다', async () => {
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          // to=UTC 09-07 23:59:59.999 = KST 09-08 08:59:59.999 — ISO slice면 '09-07',
          // tz 기준 열 키면 '09-08'이어야 한다.
          range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.999Z' }}
          onRangeChange={() => {}}
          displayTimezone="Asia/Seoul"
        />,
      ));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-range-label"]')?.textContent).toBe('09-01 ~ 09-08');
  });
});
