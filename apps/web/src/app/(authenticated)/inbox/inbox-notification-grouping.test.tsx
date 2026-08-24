// @vitest-environment jsdom
//
// story #0d1c69f3(v2 4호, 아티팩트 eb51f59e) — 인박스 알림 탭 「제네릭 반복 붕괴」. 라이브
// 실측: 동일 문안 알림 121건이 위계 없는 평면 나열이라 어느 게이트인지 구분 불가했다.
// 이 스위트는 실 DOM(createRoot, inbox-pagination.test.tsx 선례와 동형 fixture)으로
// 그룹핑(부피 붕괴)+펼침(구체 참조 칩+CTA)+개별 항목별 실 내비게이션을 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, pushMock, replaceMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('../../dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  replaceMock.mockClear();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// 라이브 실측 그대로 — gate.pending_approval, 동일 title/body, 서로 다른 reference_id/href
// (story #0d1c69f3 발견 fix: notification-navigation.ts가 reference_type='gate'를 /gates/[id]
// 로 매핑 — 이 스위트는 그 href를 API 응답이 이미 실어준 것으로 소비한다).
function genericGateNotif(id: string, refId: string) {
  return {
    id, org_id: 'o1', user_id: 'u1', type: 'gate.pending_approval',
    title: '결재 대기 중인 게이트가 있습니다', body: 'merge 게이트가 승인/거부를 기다리고 있습니다.',
    is_read: false, reference_type: 'gate', reference_id: refId, href: `/gates/${refId}`,
    created_at: '2026-01-01T00:00:00+00:00',
  };
}

function docApprovalNotif(id: string) {
  return {
    id, org_id: 'o1', user_id: 'u1', type: 'doc',
    title: "문서 결재 요청: '2985 AC② 검증용 문서'", body: null,
    is_read: false, reference_type: 'doc', reference_id: 'doc-1', href: '/docs/doc-1',
    created_at: '2026-01-01T00:00:00+00:00',
  };
}

function stubFetch(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/workflow-executions')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (typeof url === 'string' && url.includes('/api/notifications')) {
      return { ok: true, json: async () => ({ data: items, meta: { unreadCount: items.length, hasMore: false, nextCursor: null } }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

async function mount(Page: React.ComponentType) {
  await act(async () => {
    root.render(wrap(<Page />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('인박스 알림 그룹핑 — story #0d1c69f3(v2 4호, 라이브 121건 실측 축소판)', () => {
  it('동일 문안 반복(gate.pending_approval ×5)이 그룹 1개+카운트 배지로 부피 붕괴한다(AC1)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => genericGateNotif(`n${i}`, `gate-${i}`));
    stubFetch(items);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    // 붕괴 전이라면 "결재 대기 중인 게이트가 있습니다" 제목이 5번 나왔을 것 — 그룹 헤더
    // 하나로 접힌 지금은 1번만(카운트 배지가 나머지를 대신한다).
    const titleOccurrences = container.textContent!.split('결재 대기 중인 게이트가 있습니다').length - 1;
    expect(titleOccurrences).toBe(1);
    expect(container.textContent).toContain('5건');
  });

  it('그룹을 펼치면 항목별 구체 참조(reference_type 라벨+reference_id 조각)와 CTA가 뜬다(AC2 — 어느 게이트인지 답함)', async () => {
    const items = [genericGateNotif('n1', 'gate-aaaaaaaa-1111'), genericGateNotif('n2', 'gate-bbbbbbbb-2222')];
    stubFetch(items);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    const chevronBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('펼치기'));
    expect(chevronBtn).toBeTruthy();
    await act(async () => { chevronBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('게이트'); // reference_type 라벨
    expect(container.textContent).toContain('gate-aaa'); // reference_id 조각(8자)
    expect(container.textContent).toContain('gate-bbb');
    const ctaLinks = [...container.querySelectorAll('a')].filter((a) => a.textContent === '열기 →');
    expect(ctaLinks).toHaveLength(2);
  });

  it('펼친 그룹의 개별 CTA를 클릭하면 그 항목 고유의 href로 이동한다(임의의 "최신 1건" 아님 — 정직 유의)', async () => {
    const items = [genericGateNotif('n1', 'gate-target-a'), genericGateNotif('n2', 'gate-target-b')];
    stubFetch(items);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    const chevronBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('펼치기'))!;
    await act(async () => { chevronBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const ctaLinks = [...container.querySelectorAll('a')].filter((a) => a.textContent === '열기 →');
    expect(ctaLinks).toHaveLength(2);
    await act(async () => { ctaLinks[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); });

    expect(pushMock).toHaveBeenCalledWith('/gates/gate-target-b');
  });

  it('짧은(비반복) 알림 상태에서는 그룹핑이 미발동한다 — 개별 그대로(AC3 회귀 가드)', async () => {
    stubFetch([docApprovalNotif('solo')]);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    expect(container.textContent).toContain("문서 결재 요청: '2985 AC② 검증용 문서'");
    // 그룹 chevron(펼치기 aria-label)이 전혀 없어야 한다 — 단건은 그룹 UI 자체가 안 뜬다.
    const chevronBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('펼치기'));
    expect(chevronBtn).toBeFalsy();
  });

  it('구체 문안 알림(문서 결재 등)은 제네릭 알림과 섞여 있어도 개별 유지된다(제목이 서로 달라 그룹 대상 아님)', async () => {
    const items = [...Array.from({ length: 3 }, (_, i) => genericGateNotif(`g${i}`, `gate-${i}`)), docApprovalNotif('doc1')];
    stubFetch(items);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    expect(container.textContent).toContain("문서 결재 요청: '2985 AC② 검증용 문서'");
    expect(container.textContent).toContain('3건');
  });
});
