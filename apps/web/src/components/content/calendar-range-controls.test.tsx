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
  it('⭐다음 주 클릭 시 range가 정확히 7일 뒤로 이동한다(상태를 자체적으로 안 갖고 콜백만 부른다)', async () => {
    let called: { from: string; to: string } | null = null;
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.000Z' }}
          onRangeChange={(r) => { called = r; }}
        />,
      ));
    });
    const next = container.querySelector('[data-testid="channel-post-calendar-range-next"]') as HTMLButtonElement;
    await act(async () => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).toEqual({ from: '2026-09-08T00:00:00.000Z', to: '2026-09-14T23:59:59.000Z' });
  });

  it('⭐이전 주 클릭 시 range가 정확히 7일 앞으로 이동한다', async () => {
    let called: { from: string; to: string } | null = null;
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-08T00:00:00.000Z', to: '2026-09-14T23:59:59.000Z' }}
          onRangeChange={(r) => { called = r; }}
        />,
      ));
    });
    const prev = container.querySelector('[data-testid="channel-post-calendar-range-prev"]') as HTMLButtonElement;
    await act(async () => {
      prev.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.000Z' });
  });

  it('현재 범위를 MM-DD ~ MM-DD로 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <CalendarRangeControls
          range={{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.000Z' }}
          onRangeChange={() => {}}
        />,
      ));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-range-label"]')?.textContent).toBe('09-01 ~ 09-07');
  });
});
