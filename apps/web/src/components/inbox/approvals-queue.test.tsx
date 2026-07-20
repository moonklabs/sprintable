// @vitest-environment jsdom
//
// story #1960(P2-S4) — 까심 QA 지적: 이번 파라미터 조합(status/sort/assigned_to_me) 버그를
// 잡을 안전망이 없어 held+assigned_to_me 조합이 항상 빈 배열인 BE 갭(#2257 후속)이 PR
// 단계에서야 드러났다. 이 회귀가드는 fetchGates가 실제로 두 상태(pending/held)를 각각
// sort=urgency+assigned_to_me=true로 정확히 조회하는지, 4유형 렌더·노화 표시·canonical
// 상세 이동이 파라미터 조합과 무관하게 항상 서는지를 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '../kanban/types';

const { useDashboardContextMock, pushMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

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

function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'g-default',
    org_id: 'org-1',
    work_item_id: 'w-default',
    work_item_type: 'story',
    gate_type: 'merge_gate',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({
    orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }],
    projectMemberships: [],
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  pushMock.mockReset();
});

function mockFetches(pending: GateItem[], held: GateItem[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('status=pending')) return { ok: true, json: async () => pending };
    if (url.includes('status=held')) return { ok: true, json: async () => held };
    return { ok: true, json: async () => [] };
  }));
  return calls;
}

async function mount() {
  const { ApprovalsQueue } = await import('./approvals-queue');
  await act(async () => { root.render(wrap(<ApprovalsQueue />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ApprovalsQueue', () => {
  it('pending·held 두 상태를 각각 sort=urgency+assigned_to_me=true로 조회한다(파라미터 조합 회귀가드)', async () => {
    const calls = mockFetches([], []);
    await mount();
    expect(calls).toContain('/api/gates?status=pending&sort=urgency&assigned_to_me=true');
    expect(calls).toContain('/api/gates?status=held&sort=urgency&assigned_to_me=true');
  });

  it('4유형(게이트·문서결재·머지게이트·보류) 모두 렌더하고 gate_type 배지를 표시한다', async () => {
    mockFetches(
      [
        gate({ id: 'g1', gate_type: 'merge_gate', work_item_summary: { title: '머지 게이트 항목', slug: null } }),
        gate({ id: 'g2', gate_type: 'doc_approval', work_item_type: 'doc', work_item_summary: { title: '문서 결재 항목', slug: 'doc-1' } }),
        gate({ id: 'g3', gate_type: 'artifact_canonicalize', work_item_summary: null }),
      ],
      [gate({ id: 'g4', gate_type: 'merge_gate', status: 'held', held_until: null })],
    );
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('머지 게이트 항목');
    expect(text).toContain('문서 결재 항목');
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(4);
  });

  it('held gate는 보류중 배지를 표시하고 위험도 배지는 생략한다', async () => {
    mockFetches([], [gate({ id: 'g-held', status: 'held', held_until: null })]);
    await mount();
    expect(container.textContent).toContain(koMessages.cage.heldBadge);
    expect(container.textContent).not.toContain(koMessages.cage.riskUnknown);
  });

  it('held 아닌 pending gate는 위험도(unknown) 배지를 표시한다', async () => {
    mockFetches([gate({ id: 'g-pending' })], []);
    await mount();
    expect(container.textContent).toContain(koMessages.cage.riskUnknown);
  });

  it('created_at이 오늘이면 "오늘 접수", 과거면 "N일 대기"로 노화를 표시한다', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    mockFetches(
      [
        gate({ id: 'g-today', created_at: new Date().toISOString() }),
        gate({ id: 'g-old', work_item_id: 'w-old', created_at: threeDaysAgo }),
      ],
      [],
    );
    await mount();
    expect(container.textContent).toContain(koMessages.cage.queueAgeToday);
    expect(container.textContent).toContain(koMessages.cage.queueAgeDays.replace('{days}', '3'));
  });

  it('항목 탭 시 canonical 상세(/gates/{id})로 push한다(중복 빌드 봉쇄)', async () => {
    mockFetches([gate({ id: 'g-tap' })], []);
    await mount();
    const button = container.querySelector('button');
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/gates/g-tap');
  });

  it('pending·held 둘 다 비어 있으면 빈 상태 문구를 렌더한다', async () => {
    mockFetches([], []);
    await mount();
    expect(container.textContent).toContain(koMessages.cage.gateInboxEmpty);
  });

  it('BE가 held+assigned_to_me 조합을 아직 지원하지 않아 빈 배열을 반환해도 pending 항목은 정상 렌더한다', async () => {
    // #2257 갭 재현: held 쿼리가 항상 []을 반환하는 상황에서도 큐 기본 동작(pending 렌더)은 서야 한다.
    mockFetches([gate({ id: 'g-pending-only' })], []);
    await mount();
    expect(container.querySelectorAll('button').length).toBe(1);
    expect(container.textContent).not.toContain(koMessages.cage.gateInboxEmpty);
  });
});
