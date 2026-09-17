// @vitest-environment jsdom
//
// story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — AC4 렌더 3(빈 상태·결정 N·진행 中 N)
// ·1콜(today fetch 1회) 단언. 데이터층은 org-briefing-shell.test.tsx와 동형 stub(같은
// `/api/today` 계약 — 새 데이터 모양 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubToday(payload: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/today') {
      return { ok: true, status: 200, json: async () => ({ data: payload }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  });
}

async function mount() {
  const { TodayV3Screen } = await import('./today-v3-screen');
  await act(async () => { root.render(wrap(<TodayV3Screen />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const EMPTY_TODAY = {
  needs_me: [], needs_me_count: 0, agent_progress: [],
  published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
};

describe('TodayV3Screen — 렌더 3', () => {
  it('⭐빈 상태 — 결정 0·진행 0·오늘 결과는 미측정(3959 미착지)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.querySelector('h1')?.textContent).toBe('오늘');
    const summary = container.querySelector('[data-testid="today-v3-results-summary"]');
    expect(summary?.textContent).toBe('착지 미측정건 · 검수 통과 미측정건 · 열린 결함 미측정건 · 나간 글 0건.');
  });

  it('⭐결정 N — needs_me N건이 렌더된다(고위험 카드 2)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [
        {
          source: 'gate', source_id: 'g1', kind: 'approval', risk: 'high',
          work_item: { id: 'w1', type: 'channel_post', title: '블로그 글 발행' },
          requested_by: null, reason: null, created_at: '2026-09-17T00:00:00Z', conversation_id: null,
        },
        {
          source: 'hitl', source_id: 'h1', kind: 'signature', risk: 'high',
          work_item: { id: 'w2', type: 'ads_boost', title: '광고비 집행' },
          requested_by: null, reason: null, created_at: '2026-09-17T00:00:00Z', conversation_id: null,
        },
      ],
      needs_me_count: 2,
    });
    await mount();
    expect(container.textContent).toContain('블로그 글 발행');
    expect(container.textContent).toContain('광고비 집행');
    expect(container.querySelector('[data-testid="today-v3-nav-navToday"]')?.textContent).toContain('2');
  });

  it('⭐진행 中 N — agent_progress N건이 렌더된다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [
        { run_id: 'r1', agent: { name: '담롱 온찬' }, work_item: { title: '블로그 글 초안' }, status: 'running', started_at: '2026-09-17T00:00:00Z', conversation_id: null },
        { run_id: 'r2', agent: { name: '미르코 페트로비치' }, work_item: { title: '빌드 가드' }, status: 'running', started_at: '2026-09-17T00:00:00Z', conversation_id: null },
      ],
    });
    await mount();
    expect(container.textContent).toContain('담롱 온찬');
    expect(container.textContent).toContain('미르코 페트로비치');
  });

  // story #3962 CHANGES-2(페드루 PO C1, 2026-09-16 16:08Z) — 「정지」는 story #3961
  // 착지 前엔 자리만(비활성·클릭 0). 클릭해도 상태가 안 바뀌는 것(=API 호출 0)까지
  // 실증 — 「비활성이라 클릭 자체가 안 된다」는 jsdom에서 disabled 버튼의 click()이
  // 여전히 이벤트를 내지만 onClick이 없어 아무 일도 안 일어나는 것으로 고정.
  it('⭐정지 버튼 — 비활성(disabled)이고 onClick이 없어 클릭해도 무변', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [
        { run_id: 'r1', agent: { name: '담롱 온찬' }, work_item: { title: '블로그 글 초안' }, status: 'running', started_at: '2026-09-17T00:00:00Z', conversation_id: null },
      ],
    });
    await mount();
    const stopButton = container.querySelector('[data-testid="today-v3-stop-action"]') as HTMLButtonElement;
    expect(stopButton).not.toBeNull();
    expect(stopButton.disabled).toBe(true);
    const putOrPostCallsBefore = fetchMock.mock.calls.length;
    await act(async () => { stopButton.click(); });
    expect(fetchMock.mock.calls.length).toBe(putOrPostCallsBefore);
  });

  // story #3962 CHANGES-2(페드루 PO C2) — 위험 등급 태그(고위험=amber 배지)·저위험은
  // 개별 카드 대신 「저위험 N건」 한 줄로 묶인다. 「모아 승인」 실동작 검증은 story
  // #3964(today-v3-decisions.test.tsx)가 전담 — 여기선 그룹핑 표시만 확認.
  it('⭐위험 등급 태그·저위험 모아 승인 — 고위험은 배지·저위험은 묶여 한 줄로 표시된다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [
        {
          source: 'gate', source_id: 'g1', kind: 'approval', risk: 'high',
          work_item: { id: 'w1', type: 'channel_post', title: '블로그 글 발행' },
          requested_by: null, reason: null, created_at: '2026-09-17T00:00:00Z', conversation_id: null,
        },
        {
          source: 'gate', source_id: 'g2', kind: 'approval', risk: 'low',
          work_item: { id: 'w2', type: 'channel_post', title: '태그 정리' },
          requested_by: null, reason: null, created_at: '2026-09-17T00:00:00Z', conversation_id: null,
        },
        {
          source: 'gate', source_id: 'g3', kind: 'approval', risk: 'low',
          work_item: { id: 'w3', type: 'channel_post', title: '스토리 이동' },
          requested_by: null, reason: null, created_at: '2026-09-17T00:00:00Z', conversation_id: null,
        },
      ],
      needs_me_count: 3,
    });
    await mount();
    // 고위험 카드만 개별로(태그 포함), 저위험 2건은 개별 제목이 안 뜨고 한 줄로 묶인다.
    expect(container.textContent).toContain('블로그 글 발행');
    expect(container.textContent).toContain('고위험');
    expect(container.textContent).not.toContain('태그 정리');
    expect(container.textContent).not.toContain('스토리 이동');
    const lowRiskRow = container.querySelector('[data-testid="today-v3-low-risk-row"]');
    expect(lowRiskRow?.textContent).toContain('2');
    expect(container.querySelector('[data-testid="today-v3-bulk-approve-action"]')).not.toBeNull();
  });

  it('오늘 결과 — 3959 필드가 있으면(measured) 그 수를 그대로 쓴다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      landed_today: { count: 6, since: '2026-09-17T00:00:00Z' },
      qa_passed_today: { count: 3, since: '2026-09-17T00:00:00Z' },
      open_defects: { count: 2, measured: true },
      published_today: { count: 0, by_channel: [] },
    });
    await mount();
    const summary = container.querySelector('[data-testid="today-v3-results-summary"]');
    expect(summary?.textContent).toBe('착지 6건 · 검수 통과 3건 · 열린 결함 2건 · 나간 글 0건.');
  });
});

describe('TodayV3Screen — 1콜', () => {
  it('⭐/api/today를 정확히 1회만 부른다', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const todayCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/today');
    expect(todayCalls).toHaveLength(1);
  });
});
