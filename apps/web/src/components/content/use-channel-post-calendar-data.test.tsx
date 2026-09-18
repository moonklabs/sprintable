// @vitest-environment jsdom
//
// story #3422 ②-a — useChannelPostCalendarData. 이 저장소에 renderHook 유틸이 없어(grep
// 0건) page.test.tsx류와 동형으로 작은 하니스 컴포넌트를 통해 간접 테스트한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChannelPostCalendarData } from './use-channel-post-calendar-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Harness({ orgId, connectionId }: { orgId: string; connectionId?: string }) {
  const { scheduled, unscheduled, loading, error } = useChannelPostCalendarData(
    orgId, { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' }, connectionId,
  );
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{String(error)}</span>
      <span data-testid="scheduled-keys">{[...scheduled.keys()].sort().join(',')}</span>
      <span data-testid="scheduled-count">{[...scheduled.values()].reduce((n, v) => n + v.length, 0)}</span>
      <span data-testid="unscheduled-count">{unscheduled.length}</span>
    </div>
  );
}

const ORG_ID = 'org-1';

function stubFetch(opts: {
  scheduledItems?: unknown[];
  unscheduledItems?: unknown[];
  scheduledOk?: boolean;
  unscheduledOk?: boolean;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('unscheduled=true')) {
        if (opts.unscheduledOk === false) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: opts.unscheduledItems ?? [], error: null, meta: null }) };
      }
      if (url.includes('scheduled_from')) {
        if (opts.scheduledOk === false) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: opts.scheduledItems ?? [], error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

describe('useChannelPostCalendarData', () => {
  it('⭐두 축을 각각 왕복해 scheduled를 UTC 날짜로 그룹핑하고 unscheduled는 그대로 낸다', async () => {
    stubFetch({
      scheduledItems: [
        { draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', scheduled_at: '2026-09-05T21:00:00Z' },
        { draft_id: 'd2', connection_id: 'c1', channel: 'threads', body_sha256: 'h2', scheduled_at: '2026-09-05T09:00:00Z' },
        { draft_id: 'd3', connection_id: 'c1', channel: 'threads', body_sha256: 'h3', scheduled_at: '2026-09-10T00:00:00Z' },
      ],
      unscheduledItems: [{ draft_id: 'd4', connection_id: 'c1', channel: 'threads', body_sha256: 'h4' }],
    });
    await act(async () => {
      root.render(<Harness orgId={ORG_ID} />);
    });
    await flush();

    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('false');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('false');
    // 그룹핑 tz는 브라우저 tz(resolveDisplayTimezone) — 이 실행 환경(테스트러너)의 tz로
    // 계산해 기대값을 만든다(하드코딩 UTC 가정 금지, 페드루 PO 지적 2026-09-04 08:57Z).
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fmt = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    const expectedKeys = [...new Set([fmt('2026-09-05T21:00:00Z'), fmt('2026-09-05T09:00:00Z'), fmt('2026-09-10T00:00:00Z')])].sort().join(',');
    expect(container.querySelector('[data-testid="scheduled-keys"]')?.textContent).toBe(expectedKeys);
    expect(container.querySelector('[data-testid="scheduled-count"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="unscheduled-count"]')?.textContent).toBe('1');
  });

  it('⭐scheduled_at이 없는 항목(계약이 흔들린 방어 표본)은 조용히 건너뛴다', async () => {
    stubFetch({ scheduledItems: [{ draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', scheduled_at: null }] });
    await act(async () => {
      root.render(<Harness orgId={ORG_ID} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="scheduled-count"]')?.textContent).toBe('0');
  });

  it('⭐둘 중 하나라도 실패하면 error=true(부분 성공을 성공으로 그리지 않는다)', async () => {
    stubFetch({ scheduledOk: false });
    await act(async () => {
      root.render(<Harness orgId={ORG_ID} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('true');
  });

  it('⭐connectionId를 넘기면 두 요청 모두에 connection_id 쿼리가 실린다', async () => {
    let scheduledUrl = '';
    let unscheduledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('unscheduled=true')) { unscheduledUrl = url; return { ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) }; }
        scheduledUrl = url;
        return { ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) };
      }),
    );
    await act(async () => {
      root.render(<Harness orgId={ORG_ID} connectionId="c-42" />);
    });
    await flush();
    expect(scheduledUrl).toContain('connection_id=c-42');
    expect(unscheduledUrl).toContain('connection_id=c-42');
  });
});
