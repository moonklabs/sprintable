// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — missingRes(부수, "실패해도 본 화면은
// 막지 않음" 주석)가 sprintsRes/feedbackRes(주)와 같은 미격리 Promise.all 안에 있어,
// missingRes의 fetch 자체가 네트워크단 reject하면 주 데이터 둘도 같이 못 얻던 결함의
// 회귀가드. 전체 기능 스위트가 아니라 이 격리 하나만 좁게 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({ StandupBoardCard: () => null }));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({ StandupFeedbackDialog: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(opts: { missingReject?: boolean; entries?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: opts.entries ?? [] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
    }
    if (url.includes('/api/standup/feedback')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/standup/missing')) {
      if (opts.missingReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: [] }) };  // story #4298 — BE `[{id, name}]`(BFF가 data로 감쌈)
    }
    if (url.includes('/api/stories?project_id=')) {
      return { ok: true, json: async () => ({ data: [], meta: {} }) };
    }
    return { ok: false, json: async () => null };
  }));
}

async function mount(props: { embedded?: boolean } = {}) {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(wrap(<StandupPage projectId="proj-1" {...props} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('StandupClient — missing 격리(story #3519)', () => {
  it('missing이 네트워크 reject해도 활성 스프린트(주 데이터)는 그대로 뜬다(loadError 없음)', async () => {
    stubFetch({ missingReject: true });
    await mount();
    expect(container.textContent).toContain('진행중 스프린트');
    expect(container.textContent).not.toContain(koMessages.standup.loadFailed);
  });
});

describe('StandupClient — embedded prop(story #3845 §①, TopBarSlot 싱글톤 충돌 회피)', () => {
  // TopBarSlot 자체는 이 파일 상단에서 () => null로 스텁돼 있어(다른 스위트와 동형) 그
  // 안으로 넘어가는 title prop은 DOM에 안 남는다 — 이 두 테스트가 실제로 보는 것은 전혀
  // 다른 자리(TopBarSlot 호출 밖, 컴포넌트 자신의 return에 직접 있는 절 헤딩 <h2>)다.
  it('embedded=true면 TopBarSlot 대신 절 헤딩("하루 체크인")이 DOM에 직접 뜬다', async () => {
    stubFetch();
    await mount({ embedded: true });
    expect(container.textContent).toContain(koMessages.standup.embeddedHeading);
  });

  it('embedded 미지정(기본 false)이면 절 헤딩이 안 뜬다(TopBarSlot 경로로만 감, DOM엔 없음)', async () => {
    stubFetch();
    await mount();
    expect(container.textContent).not.toContain(koMessages.standup.embeddedHeading);
  });

  it('embedded=true·오늘 entries 0건이면 「오늘 체크인이 아직 없어요」가 뜬다(§⑤ 빈 상태, 사람 카드 그리드는 안 가림)', async () => {
    stubFetch({ entries: [] });
    await mount({ embedded: true });
    expect(container.textContent).toContain(koMessages.standup.noCheckinsToday);
  });

  it('음성대조 — entries가 1건 이상이면 그 빈 상태 문구가 안 뜬다', async () => {
    stubFetch({ entries: [{ id: 'e1', author_id: 'me-1', date: '2026-09-14', done: '', plan: '', blockers: null, plan_story_ids: [] }] });
    await mount({ embedded: true });
    expect(container.textContent).not.toContain(koMessages.standup.noCheckinsToday);
  });
});
