// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CalendarGrid } from './calendar-grid';
import type { ChannelPostCalendarItem } from './use-channel-post-calendar-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

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
      root.render(wrap(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-07T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      ));
    });
    const headers = container.querySelectorAll('[data-testid="channel-post-calendar-date-header"]');
    expect(headers.length).toBe(3);
    expect([...headers].map((h) => h.textContent)).toEqual(['09-05', '09-06', '09-07']);
  });

  it('⭐채널마다 한 행씩 낸다', async () => {
    await act(async () => {
      root.render(wrap(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }, { connectionId: 'c2', label: 'Threads @b' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-05T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      ));
    });
    const rows = container.querySelectorAll('[data-testid="channel-post-calendar-channel-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('Threads @a');
    expect(rows[1]?.textContent).toContain('Threads @b');
  });

  it('빈 scheduled여도 격자 자체(빈 셀들)는 채널 수×날짜 수만큼 선다', async () => {
    await act(async () => {
      root.render(wrap(
        <CalendarGrid
          scheduled={new Map()}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-06T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      ));
    });
    expect(container.querySelectorAll('[data-testid="channel-post-calendar-cell"]').length).toBe(2);
  });

  // story #3422 ②-b 3/N-b — 셀 배치.
  it('⭐그 (채널, 날짜)의 항목만 그 셀에 배치한다(다른 채널 것은 안 섞인다)', async () => {
    const itemC1: ChannelPostCalendarItem = { draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', gate_status: null };
    const itemC2: ChannelPostCalendarItem = { draft_id: 'd2', connection_id: 'c2', channel: 'threads', body_sha256: 'h2', gate_status: null };
    const scheduled = new Map([['2026-09-05', [itemC1, itemC2]]]);
    await act(async () => {
      root.render(wrap(
        <CalendarGrid
          scheduled={scheduled}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }, { connectionId: 'c2', label: 'Threads @b' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-05T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      ));
    });
    const rows = container.querySelectorAll('[data-testid="channel-post-calendar-channel-row"]');
    expect(rows[0]?.querySelectorAll('[data-testid="channel-post-calendar-card"]').length).toBe(1);
    expect(rows[1]?.querySelectorAll('[data-testid="channel-post-calendar-card"]').length).toBe(1);
  });

  it('같은 (채널, 날짜)에 여러 초안이 있으면 전부 쌓아 보인다(하나로 뭉개지 않는다)', async () => {
    const items: ChannelPostCalendarItem[] = [
      { draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', gate_status: null },
      { draft_id: 'd2', connection_id: 'c1', channel: 'threads', body_sha256: 'h2', gate_status: null },
    ];
    const scheduled = new Map([['2026-09-05', items]]);
    await act(async () => {
      root.render(wrap(
        <CalendarGrid
          scheduled={scheduled}
          channels={[{ connectionId: 'c1', label: 'Threads @a' }]}
          range={{ from: '2026-09-05T00:00:00Z', to: '2026-09-05T23:59:59Z' }}
          displayTimezone="UTC"
        />,
      ));
    });
    expect(container.querySelectorAll('[data-testid="channel-post-calendar-card"]').length).toBe(2);
  });
});
