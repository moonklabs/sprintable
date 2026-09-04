// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarGrid } from './calendar-grid';

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

describe('CalendarGrid — story #3422 ②-b 3/N-a, 골격(날짜 열·채널 행)', () => {
  it('⭐range의 날짜를 하루 단위로 전부 열로 낸다(3일 범위 → 열 3개)', async () => {
    await act(async () => {
      root.render(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-07T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      );
    });
    const headers = container.querySelectorAll('[data-testid="channel-post-calendar-date-header"]');
    expect(headers.length).toBe(3);
    expect([...headers].map((h) => h.textContent)).toEqual(['09-05', '09-06', '09-07']);
  });

  it('⭐채널마다 한 행씩 낸다', async () => {
    await act(async () => {
      root.render(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }, { connectionId: 'c2', label: 'Threads @b' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-05T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      );
    });
    const rows = container.querySelectorAll('[data-testid="channel-post-calendar-channel-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('Threads @a');
    expect(rows[1]?.textContent).toContain('Threads @b');
  });

  it('빈 scheduled여도 격자 자체(빈 셀들)는 채널 수×날짜 수만큼 선다', async () => {
    await act(async () => {
      root.render(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-06T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      );
    });
    expect(container.querySelectorAll('[data-testid="channel-post-calendar-cell"]').length).toBe(2);
  });
});
