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

function stubFetch(opts: { missingReject?: boolean; entries?: unknown[]; members?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: opts.entries ?? [] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: opts.members ?? [] }) };
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

// [SID:4300] 막힘 모음의 작성자 이름 — 예전엔 이름이 빈 구성원도 «알 수 없음»이었다. #4284 계약: 표에 있는데 이름 빔 = «이름 없는
// 구성원», 표에 없음 = «알 수 없는 구성원». 두 갈래를 한 화면에서 가른다.
describe('StandupClient — 막힘 모음 작성자 이름([SID:4300])', () => {
  it('이름 빔 → «이름 없는 구성원» · 표에 없음 → «알 수 없는 구성원» · «알 수 없음» 0', async () => {
    stubFetch({
      members: [{ id: 'm-noname', name: null, type: 'human' }, { id: 'm-anna', name: '안나', type: 'human' }],
      entries: [
        { id: 'e1', author_id: 'm-noname', date: '2026-09-25', done: '', plan: '', blockers: '빌드 막힘', plan_story_ids: [] },
        { id: 'e2', author_id: 'm-gone', date: '2026-09-25', done: '', plan: '', blockers: '권한 막힘', plan_story_ids: [] },
        { id: 'e3', author_id: 'm-anna', date: '2026-09-25', done: '', plan: '', blockers: '리뷰 대기', plan_story_ids: [] },
      ],
    });
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('빌드 막힘');
    expect(text).toContain(koMessages.common.memberUnnamed);
    expect(text).toContain(koMessages.common.memberUnknown);
    expect(text).toContain('안나');
    expect(text).not.toContain(koMessages.standup.unknown);
  });

  it('[SID:4311 PR 2] 같은 이름 작성자 둘(«송윤재» · 서로 다른 구성원)은 «· ID 앞 8자»로 두 줄이 갈린다 · 다른 이름은 꼬리 없음', async () => {
    stubFetch({
      members: [
        { id: 'e75ca548-1', name: '송윤재', type: 'human' },
        { id: '2fd14616-2', name: '송윤재', type: 'human' },
        { id: 'm-anna', name: '안나', type: 'human' },
      ],
      entries: [
        { id: 'e1', author_id: 'e75ca548-1', date: '2026-09-25', done: '', plan: '', blockers: '빌드 막힘', plan_story_ids: [] },
        { id: 'e2', author_id: '2fd14616-2', date: '2026-09-25', done: '', plan: '', blockers: '권한 막힘', plan_story_ids: [] },
        { id: 'e3', author_id: 'm-anna', date: '2026-09-25', done: '', plan: '', blockers: '리뷰 대기', plan_story_ids: [] },
      ],
    });
    await mount();
    const lines = [...container.querySelectorAll('p')].map((p) => p.textContent ?? '');
    expect(lines).toContain('송윤재 · e75ca548 · 빌드 막힘');
    expect(lines).toContain('송윤재 · 2fd14616 · 권한 막힘');
    expect(lines).toContain('안나 · 리뷰 대기');
  });

  it('오늘 명단(활성만)에 없는 작성자(비활성 에이전트) → 비활성까지 싣는 조직 원천으로 이름', async () => {
    const { ORG_NAMES_URL } = await import('@/hooks/use-member-name-fallback');
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgId: 'org-1' });
    stubFetch({
      members: [{ id: 'm-anna', name: '안나', type: 'human' }],
      entries: [{ id: 'e1', author_id: 'a-inactive', date: '2026-09-25', done: '', plan: '', blockers: '배포 막힘', plan_story_ids: [] }],
    });
    const base = globalThis.fetch as unknown as (url: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === ORG_NAMES_URL ? { ok: true, json: async () => ({ data: [{ id: 'a-inactive', name: '쉬는봇', type: 'agent' }] }) } : base(url)
    )));
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = container.textContent ?? '';
    expect(text).toContain('배포 막힘');
    expect(text).toContain('쉬는봇');
    expect(text).not.toContain(koMessages.common.memberUnknown);
  });
});
