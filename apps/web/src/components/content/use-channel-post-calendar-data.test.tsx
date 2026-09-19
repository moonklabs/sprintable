// @vitest-environment jsdom
//
// story #3422 ②-a — useChannelPostCalendarData. 이 저장소에 renderHook 유틸이 없어(grep
// 0건) page.test.tsx류와 동형으로 작은 하니스 컴포넌트를 통해 간접 테스트한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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

  // story #4071 마이그 핵심 회귀 — 사전조사 doc §2가 잡은 클래스: 원본은 loading을
  // useState(true)로 초기화해, orgId가 처음부터 undefined면(조직 미확定 등) 그 값을
  // 되돌릴 분기 자체가 없어 loading이 영구 true였다. useAsyncResource 마이그 후엔 스킵
  // 경로도 구조적으로 loading=false로 닫힌다.
  function UndefinedOrgHarness({ orgId }: { orgId: string | undefined }) {
    const { loading, error } = useChannelPostCalendarData(
      orgId, { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' },
    );
    return (
      <div>
        <span data-testid="loading">{String(loading)}</span>
        <span data-testid="error">{String(error)}</span>
      </div>
    );
  }

  it('orgId가 처음부터 undefined면(마운트 시점) loading이 고착되지 않고 false다(#4071 핵심 회귀)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<UndefinedOrgHarness orgId={undefined} />);
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('false');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('false');
  });

  // story #4071 qa:changes(카디르, #4444와 동일 클래스, 2026-09-19) — 원본 skip 조건
  // `if (!orgId)`는 falsy 전부(빈 문자열 포함)를 스킵으로 봤다. useAsyncResource의 skip
  // 판정은 null/undefined만 인식하므로, orgId=''를 정규화 없이 넘기면 실제 fetch가 나가
  // "기존동작 무변" 계약이 깨진다 — 핵심 회귀.
  it('orgId가 빈 문자열이어도(falsy) fetch 자체를 호출하지 않는다(#4071 재QA 핵심 회귀)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<UndefinedOrgHarness orgId="" />);
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('false');
  });

  // story #4071 qa:changes(카디르, 2026-09-19, useAsyncResource 헬퍼 설계갭) — 원본은
  // 재조회 실패(!ok) 시 setScheduled/setUnscheduled를 아예 안 불러 "이전 성공 데이터
  // 유지 + error만 세움"이었다(develop 원본 실측 확認). useAsyncResource 기본값(실패 시
  // initial로 리셋)을 그대로 썼으면 캘린더가 이미 그려둔 일정이 실패 화면으로 지워지는
  // 회귀가 났다 — keepPreviousDataOnError:true로 원본 계약 복원, 핵심 회귀.
  it('최초 성공 後 재조회가 실패해도 이전 scheduled/unscheduled 데이터를 유지한다(#4071 헬퍼 설계갭 핵심 회귀)', async () => {
    stubFetch({
      scheduledItems: [{ draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1', scheduled_at: '2026-09-05T21:00:00Z' }],
      unscheduledItems: [{ draft_id: 'd2', connection_id: 'c1', channel: 'threads', body_sha256: 'h2' }],
    });

    function Switcher() {
      const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
      return (
        <>
          <button data-testid="switch" onClick={() => setConnectionId('c-fail')}>switch</button>
          <Harness orgId={ORG_ID} connectionId={connectionId} />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(container.querySelector('[data-testid="scheduled-count"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="unscheduled-count"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('false');

    // connectionId 변경 → deps 변화로 재조회, 이번엔 실패하도록 스텁 교체.
    stubFetch({ scheduledOk: false });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();

    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('true');
    // 이전 데이터가 실패 화면으로 안 지워진다 — 원본 계약.
    expect(container.querySelector('[data-testid="scheduled-count"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="unscheduled-count"]')?.textContent).toBe('1');
  });

  // story #4071 qa:changes(유나 design, 2026-09-19, 마운트 flash) — 원본은
  // `useState(true)`로 loading을 초기화해 마운트 즉시(첫 페인트부터) 로딩 상태였다.
  // renderToStaticMarkup은 effect를 안 돌려 useState 초기값(=실 첫 페인트가 낼 값) 그대로를
  // 관측한다 — act() 기반 렌더는 effect의 동기 부분까지 자체 플러시해버려 이 차이를
  // 못 잡는다(핵심 회귀, initialLoading:true 없으면 FAIL).
  it('마운트 첫 페인트부터 loading이 이미 true다(EmptyState가 한 프레임도 안 보임, 핵심 회귀)', () => {
    const html = renderToStaticMarkup(<Harness orgId={ORG_ID} />);
    const loadingText = html.match(/data-testid="loading">(.*?)<\/span>/)![1];
    expect(loadingText).toBe('true');
  });
});
