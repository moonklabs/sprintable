// @vitest-environment jsdom
//
// story ded31cb3 — NowFace 왕복 검증: 2 BFF(my-actions·notifications) 조합이 실제로 결정대기/이상신호/
// 완료보고 3종 행으로 렌더되는지, 기본 5+"+N 더" 인라인 펼침이 실제로 동작하는지(정적 캡 아님), 이상
// 신호 카피에 경과시간이 새지 않는지(감시 금지) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NowFace } from './now-face';
import koMessages from '../../../messages/ko.json';

// story #3180 — mux는 mock으로 대체(now-strip.test.tsx와 동형 관례). 기본 null 반환이라
// 기존 테스트 전부(mux 미언급)는 「Provider 밖」 폴백 경로 그대로 무회귀.
const { useSseMultiplexerContextMock } = vi.hoisted(() => ({ useSseMultiplexerContextMock: vi.fn() }));
vi.mock('@/components/realtime-provider', () => ({ useSseMultiplexerContext: () => useSseMultiplexerContextMock() }));

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
  useSseMultiplexerContextMock.mockReset();
  useSseMultiplexerContextMock.mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubFetch(myActions: unknown, notifications: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/dashboard/my-actions')) return { ok: true, json: async () => myActions };
    if (url.includes('/api/notifications')) return { ok: true, json: async () => notifications };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<NowFace />)); });
  // flush the Promise.all([...]) microtask chain + resulting setState.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('NowFace', () => {
  it('renders one row per kind (결정 대기/이상 신호/완료 보고) from the two combined BFFs', async () => {
    stubFetch(
      {
        action_queue: { items: [{ type: 'gate_approval', priority: 'warn', context: { kind: 'canonical' } }] },
        attention: { items: [{ type: 'agent_stuck', entity_type: 'story', entity_id: 's1', gate_type: 'merge' }] },
      },
      { data: [{ id: 'n1', title: 'BE 계약 완료', body: '근거 3건 첨부', href: '/inbox' }] },
    );
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('결정 대기');
    expect(html).toContain('이상 신호');
    expect(html).toContain('완료 보고');
    expect(html).toContain('BE 계약 완료');
    // 까심 REQUEST_CHANGES(#2162 축3) — 이 테스트는 이미 원시 슬러그(context.kind='canonical',
    // gate_type='merge')를 입력으로 제공하는데 그 슬러그가 카피에 안 새는지 확인하는 negative
    // 어서션이 없었다 — 카피 스윕이 decideGateContextKind 분기·{gate} 인터폴레이션을 걷어냈어도
    // 이 테스트 자체는 구버전(슬러그 그대로 노출)이 되돌아와도 계속 PASS하는 공허 통과였다
    // (S2/S3와 동형 클래스). 입력에 실제로 준 슬러그가 렌더 결과에 없다는 걸 여기서 직접 검증한다.
    expect(html).not.toContain('canonical'); // context.kind 슬러그 미노출
    expect(html).not.toContain('merge'); // gate_type 슬러그 미노출
  });

  // story #3009(로드맵 P2·PR-F, L1) — hover 시 인라인 카드 강조는 --elev-card.
  it('카드 셸이 hover:shadow-[var(--elev-card)]를 쓰고 hover:shadow-sm은 안 쓴다', async () => {
    stubFetch(
      { action_queue: { items: [{ type: 'gate_approval', priority: 'warn', context: { kind: 'canonical' } }] }, attention: { items: [] } },
      { data: [] },
    );
    await mount();
    const card = container.querySelector('.rounded-2xl.border.border-border.bg-card');
    expect(card?.className).toContain('hover:shadow-[var(--elev-card)]');
    expect(card?.className).not.toMatch(/hover:shadow-sm(\s|$)/);
  });

  it('renders the calm empty state ("모두 확인했어요") when both sources are empty — no alarming iconography text', async () => {
    stubFetch(
      { action_queue: { items: [] }, attention: { items: [] } },
      { data: [] },
    );
    await mount();
    expect(container.innerHTML).toContain('모두 확인했어요');
  });

  it('caps at 5 rows by default with a "+N 더" toggle, and clicking it reveals the rest in place (no priority cut, no navigation away)', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      type: 'agent_stuck', entity_type: 'story', entity_id: `s${i}`, gate_type: 'merge',
    }));
    stubFetch(
      { action_queue: { items: [] }, attention: { items } },
      { data: [] },
    );
    await mount();
    const rowsBefore = container.querySelectorAll('a').length;
    expect(rowsBefore).toBe(5);
    expect(container.innerHTML).toContain('3개 더 보기');

    const moreButton = container.querySelector('button');
    expect(moreButton).toBeTruthy();
    await act(async () => { moreButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const rowsAfter = container.querySelectorAll('a').length;
    expect(rowsAfter).toBe(8);
    expect(container.innerHTML).not.toContain('3개 더 보기');
  });

  // story #2541(PO (가) 결정, 유나 v4 SSOT f01fa94a) — story_stalled는 이제 NowFace 플랫
  // 행이 아니라 AttentionClusterBoard의 "정체" 클러스터로 옮겨갔고, 그 클러스터는 "N일째"
  // (개별 카드)·"3일+"(카드 헤더 임계값 설명)를 의도적으로 보인다 — 옛 감시-프레이밍 금지가
  // 「개별 신호마다 경과를 드러내면 감시처럼 읽힌다」는 근거였는데, 유형별로 묶어 "정체 N건"
  // 지표로 보여주는 이 클러스터 형태엔 그 근거가 적용되지 않는다는 게 PO 판단(§derive-now-face.ts
  // stalled_days 주석과 동일 근거). 그래서 이 가드는 "일째"·"일+" 두 의도된 패턴만 허용하고,
  // 그 밖의 경과시간 포맷(예: agent_stuck에 "N시간 전"류가 새로 붙는 회귀)은 여전히 잡는다.
  it('never leaks raw elapsed-time digits into the anomaly row copy, except the intentional stalled-cluster day-count (story #2541)', async () => {
    stubFetch(
      { action_queue: { items: [] }, attention: { items: [{ type: 'story_stalled', entity_type: null, entity_id: 's1', gate_type: null }] } },
      { data: [] },
    );
    await mount();
    expect(container.innerHTML).not.toMatch(/\d+\s*(분|시간|일)(?!건|째|\+)/);
  });

  it('story 64b9a879 — "지금" hero 뱃지가 타이틀 옆에 렌더된다(정보 위계 강조)', async () => {
    stubFetch({ action_queue: { items: [] }, attention: { items: [] } }, { data: [] });
    await mount();
    const badge = [...container.querySelectorAll('span')].find((s) => s.textContent === '지금');
    expect(badge).not.toBeUndefined();
  });

  // story #2856 — 이 테스트 하네스는 useDashboardContext()에 Provider를 안 씌워 기본값
  // (orgSlug/activeProjectId 둘 다 undefined)을 쓴다 — viewer 미제공 구 호출부와 동형이라
  // project_id/project_slug가 payload에 있어도 crossProjectLabel은 항상 null이어야 한다
  // (derive-now-face.test.ts가 순수함수 축은 이미 잠금 — 여기선 그 폴백이 실 렌더에서도
  // 안전한지만 확認).
  it('viewer 미제공 컨텍스트에서는 project_id가 있어도 프로젝트 태그를 그리지 않는다(회귀 0)', async () => {
    stubFetch(
      {
        action_queue: { items: [] },
        attention: { items: [{ type: 'agent_stuck', entity_type: 'story', entity_id: 's1', gate_type: 'merge', project_id: 'p-other', project_slug: 'other-proj' }] },
      },
      { data: [] },
    );
    await mount();
    expect(container.textContent).not.toContain('other-proj');
  });
});

describe('NowFace — story #3180 attention.changed 신호(AC2 즉시 재조회·AC3 하위호환)', () => {
  it('mux가 없으면(플래그 OFF·Provider 밖) subscribe를 호출하지 않는다 — 폴링만 남는다', async () => {
    const subscribe = vi.fn();
    useSseMultiplexerContextMock.mockReturnValue(null);
    stubFetch({ action_queue: { items: [] }, attention: { items: [] } }, { data: [] });
    await mount();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('mux가 있으면 attention.changed를 구독하고, 신호 수신 시 즉시 재조회한다', async () => {
    let handler: (() => void) | undefined;
    const subscribe = vi.fn((name: string, fn: () => void) => { handler = fn; return vi.fn(); });
    useSseMultiplexerContextMock.mockReturnValue({ subscribe, subscribeMessage: vi.fn(), subscribeReconnect: vi.fn(), connected: true });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/dashboard/my-actions')) return { ok: true, json: async () => ({ action_queue: { items: [] }, attention: { items: [] } }) };
      if (url.includes('/api/notifications')) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: false, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(subscribe).toHaveBeenCalledWith('attention.changed', expect.any(Function));
    const callsAfterMount = fetchMock.mock.calls.length;
    expect(handler).toBeTruthy();
    await act(async () => { handler!(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});
