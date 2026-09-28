// @vitest-environment jsdom
//
// story #4336 PR2 ②(PO 04:32Z) — 컨텍스트 팩 캐시 미스면 BE가 202 + 작업(loop_context_pack). 패널은 스켈레톤을 두고 작업을 기다리고
// (10초 넘으면 «창을 닫아도 계속 처리돼요»), 끝나면 작업 result.pack을 예전 200 응답과 똑같이 그린다. 캐시 적중(200)은 예전 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ContextPackPanel } from './context-pack-panel';
import { SLOW_JOB_NOTICE_MS } from '@/lib/background-job';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { fetchWithAuthMock, waitForBackgroundJobMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn(), waitForBackgroundJobMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/background-job', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  waitForBackgroundJob: (...args: unknown[]) => waitForBackgroundJobMock(...args),
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: 'org-1' }) }));

const PACK = {
  items: [{ entity_type: 'hypothesis', entity_id: 'h-1', similarity: 0.9, goal: '예전 가설', decision: null, outcome: null, href: null }],
  embed_available: true, synthesis: '배운 것 요약', synthesis_confidence: 'high', recommendation: null, recommendation_confidence: null, evidence_count: 1,
};
const QUEUED = { id: 'job-1', kind: 'loop_context_pack', status: 'pending', result: null, error: null };

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ContextPackPanel loopId="loop-1" />
      </NextIntlClientProvider>,
    );
  });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const respond = (body: unknown, status = 200) => fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); fetchWithAuthMock.mockReset(); waitForBackgroundJobMock.mockReset(); });
afterEach(() => { act(() => { root.unmount(); }); container.remove(); vi.useRealTimers(); });

describe('ContextPackPanel — 캐시 미스 작업(#4336 PR2 ②)', () => {
  it('캐시 적중(200)은 예전 그대로 곧바로 그린다 · 작업을 기다리지 않는다', async () => {
    respond(PACK);
    mount();
    await flush();
    expect(container.textContent).toContain('배운 것 요약');
    expect(waitForBackgroundJobMock).not.toHaveBeenCalled();
  });

  it('⭐202 + 작업 → 스켈레톤 · 10초 전엔 없고 넘으면 «창을 닫아도 계속 처리돼요» → 작업이 끝나면 result.pack을 그린다', async () => {
    let release: (job: unknown) => void = () => {};
    waitForBackgroundJobMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    respond(QUEUED, 202);
    mount();
    await flush();
    expect(waitForBackgroundJobMock.mock.calls[0].slice(0, 2)).toEqual(['org-1', 'job-1']);
    expect(container.textContent).not.toContain('창을 닫아도 계속 처리돼요');
    await act(async () => { vi.advanceTimersByTime(SLOW_JOB_NOTICE_MS); });
    expect(container.textContent).toContain('창을 닫아도 계속 처리돼요');
    // 유나 CHANGES(PR 4780) — 느림 줄 · 부제가 360에서 낱말 가운데서 끊기지 않게.
    const ps = [...container.querySelectorAll('p')];
    expect(ps.find((p) => p.textContent?.includes('창을 닫아도'))?.classList.contains('break-keep')).toBe(true);
    expect(ps.find((p) => p.textContent === koMessages.loops.contextPackSubtitle)?.classList.contains('break-keep')).toBe(true);

    await act(async () => { release({ ...QUEUED, status: 'completed', result: { pack: PACK } }); });
    await flush();
    expect(container.textContent).toContain('배운 것 요약');
    expect(container.textContent).not.toContain('창을 닫아도 계속 처리돼요');
  });

  it('작업이 실패로 끝나면 «이력 조회를 일시 생략했어요»(예전 오류 응답과 같은 자리)', async () => {
    waitForBackgroundJobMock.mockResolvedValue({ ...QUEUED, status: 'failed', error: { status_code: 404, detail: 'Loop not found' } });
    respond(QUEUED, 202);
    mount();
    await flush();
    await flush();
    expect(container.textContent).toContain('이력 조회를 일시 생략했어요');
  });
});
