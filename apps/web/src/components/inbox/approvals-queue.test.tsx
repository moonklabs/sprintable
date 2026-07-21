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
import type { GateItem, HitlInboxItem } from '../kanban/types';

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
    source: 'gate',
    ...overrides,
  };
}

// story #2054: HitlRequest(gate_approval park) 결재함 인박스 항목 픽스처.
function hitl(overrides: Partial<HitlInboxItem>): HitlInboxItem {
  return {
    source: 'hitl',
    id: 'h-default',
    request_type: 'gate_approval',
    title: '기본 승인 요청',
    prompt: 'merge 전이는 사람 승인 대기',
    status: 'pending',
    requires_human: true,
    work_item_id: null,
    work_type: 'merge',
    created_at: new Date().toISOString(),
    expires_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // story #2103 — 기본값은 human(기존 스위트 전부가 "승인/반려 버튼이 보인다"를 전제하므로).
  // agent 게이팅 자체를 검증하는 케이스만 개별로 override한다.
  useDashboardContextMock.mockReturnValue({
    orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }],
    projectMemberships: [],
    currentMemberType: 'human',
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  pushMock.mockReset();
});

// story #2054: /api/gates → /api/gates/inbox로 교체(Gate+HitlRequest 통합). pending/held
// 각각에 gate·hitl 항목을 섞어 반환할 수 있다. PATCH(hitl 승인/반려)도 같은 mock으로 기록한다.
function mockFetches(
  pending: (GateItem | HitlInboxItem)[],
  held: (GateItem | HitlInboxItem)[],
  patchOk = true,
) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body });
    if (init?.method === 'PATCH') return { ok: patchOk, json: async () => ({}) };
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
    const urls = calls.map((c) => c.url);
    expect(urls).toContain('/api/gates/inbox?status=pending&sort=urgency&assigned_to_me=true');
    expect(urls).toContain('/api/gates/inbox?status=held&sort=urgency&assigned_to_me=true');
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

  // story #2054 — Gate와 HitlRequest가 같은 승인 병목(merge)에서 서로를 못 보던 결함의
  // 회귀가드. hitl 항목은 상세 페이지가 없어 큐 안에서 바로 승인/반려한다(Gate처럼 클릭
  // 시 상세로 이동하지 않는다 — 별도 버튼).
  it('hitl 항목을 렌더하고 승인 요청 배지·title·prompt를 보여준다', async () => {
    mockFetches([hitl({ id: 'h1', title: 'merge 승인 대기', prompt: '사람 승인이 필요합니다' })], []);
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain(koMessages.cage.hitlRequestBadge);
    expect(text).toContain('merge 승인 대기');
    expect(text).toContain('사람 승인이 필요합니다');
  });

  it('hitl 항목 승인 클릭 시 PATCH /api/v1/hitl-requests/{id}를 status=approved로 호출하고 목록에서 사라진다', async () => {
    const calls = mockFetches([hitl({ id: 'h-approve' })], []);
    await mount();
    const approveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.url).toBe('/api/v1/hitl-requests/h-approve');
    expect(JSON.parse(patchCall?.body ?? '{}')).toEqual({ status: 'approved' });
    expect(container.textContent).toContain(koMessages.cage.gateInboxEmpty);
  });

  it('hitl 항목 반려 클릭 시 PATCH를 status=rejected로 호출한다', async () => {
    const calls = mockFetches([hitl({ id: 'h-reject' })], []);
    await mount();
    const rejectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateReject));
    await act(async () => { rejectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patchCall?.body ?? '{}')).toEqual({ status: 'rejected' });
  });

  it('gate·hitl 항목이 섞인 목록에서 gate만 상세로 push하고 hitl은 push하지 않는다', async () => {
    mockFetches(
      [
        gate({ id: 'g-mixed', work_item_summary: { title: '머지 게이트', slug: null } }),
        hitl({ id: 'h-mixed', title: 'HITL 승인' }),
      ],
      [],
    );
    await mount();
    const gateButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('머지 게이트'));
    await act(async () => { gateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/gates/g-mixed');
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining('h-mixed'));
  });

  // story #2103(P0) — BE `PATCH /api/v1/hitl-requests/{id}`가 human-only 불변식(hitl.py:131,
  // "gates.py transition_gate_endpoint와 같은"). #2091(게이트 상세)과 같은 버그클래스: 이 큐가
  // 그 판정을 미리 안 보고 에이전트 계정에도 승인/반려 버튼을 무조건 열었다. 양방향(human→노출·
  // agent→비노출+사유문구) 다 고정한다 — 한쪽만 보면 "항상 노출" 회귀도 통과한다.
  it('agent 계정이면 hitl 승인/반려 버튼이 안 뜨고 권한없음 문구가 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({
      orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }],
      projectMemberships: [],
      currentMemberType: 'agent',
    });
    mockFetches([hitl({ id: 'h-agent', title: 'agent가 보는 승인요청' })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(false);
    expect(container.textContent).toContain(koMessages.cage.gateReadonlyNotAuthorized);
  });

  it('currentMemberType이 응답에 없으면(구버전/누락) undefined→false로 안전하게 폴백해 버튼을 안 연다(fail-closed)', async () => {
    useDashboardContextMock.mockReturnValue({
      orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }],
      projectMemberships: [],
    });
    mockFetches([hitl({ id: 'h-unknown' })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  it('human 계정이면 hitl 승인/반려 버튼이 뜬다(회귀 확認)', async () => {
    mockFetches([hitl({ id: 'h-human' })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(true);
  });
});
