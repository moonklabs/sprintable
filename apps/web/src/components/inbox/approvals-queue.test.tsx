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

  // story #1961(P2-S5) — 저위험 gate 인라인 승인/반려. gates/[id]/page.tsx의 canAct 판정
  // (needsAction && can_approve===true)과 risk==='low'(usesSignatureFlow===false)를 모두
  // 충족해야 승인/반려 버튼이 뜬다.
  function lowRiskActionable(overrides: Partial<GateItem> = {}): GateItem {
    return gate({
      id: 'g-low', gate_type: 'merge_gate', status: 'pending', requires_human: true,
      can_approve: true, risk_grade: 'low', work_item_summary: { title: '저위험 항목', slug: null },
      ...overrides,
    });
  }

  it('AC — 저위험(risk_grade=low)·승인권한 있는 gate는 인라인 승인/반려 버튼이 뜬다', async () => {
    mockFetches([lowRiskActionable()], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(true);
  });

  it('AC "고위험 항목 인라인 승인 버튼 0" — risk_grade=high는 인라인 버튼이 아예 없고 행 전체가 상세 이동 버튼 하나뿐이다', async () => {
    mockFetches([lowRiskActionable({ id: 'g-high', risk_grade: 'high' })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(false);
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('risk_grade가 unknown(미배선)이어도 인라인 버튼이 안 뜬다(보수적 고위험 취급, gate-risk.ts 정책)', async () => {
    mockFetches([lowRiskActionable({ id: 'g-unknown', risk_grade: null })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  it('can_approve=false면 저위험이어도 인라인 버튼이 안 뜬다(per-caller 권한 게이팅)', async () => {
    mockFetches([lowRiskActionable({ id: 'g-noperm', can_approve: false })], []);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  it('AC "승인 후 완료 상태+서명 기록 링크 즉시" — 승인 클릭 시 POST /api/gates/{id}/transition을 호출하고, 재조회 없이 완료 배지+기록 링크로 즉시 바뀐다', async () => {
    const calls = mockFetches([lowRiskActionable()], []);
    await mount();
    const approveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.url).toBe('/api/gates/g-low/transition');
    expect(JSON.parse(postCall?.body ?? '{}')).toEqual({ status: 'approved', note: null });

    expect(container.textContent).toContain(koMessages.cage.queueResolvedApproved);
    expect(container.textContent).toContain(koMessages.cage.queueViewRecord);
    // 승인/반려 버튼 자체가 사라진다(재클릭 물리적으로 불가 — 중복 실행 방지의 두 번째 층).
    const buttonsAfter = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttonsAfter.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    // 재조회(fetchGates) 없이 이 렌더만으로 반영됐다 — GET 호출 수가 mount 시점(pending+held
    // 각 1회=2)에서 늘지 않았다.
    expect(calls.filter((c) => c.method === undefined || c.method === 'GET')).toHaveLength(2);
  });

  it('AC "중복 탭 중복 실행 0" — 승인 요청이 아직 안 끝난 상태에서 버튼이 비활성화돼 재클릭이 두 번째 요청을 만들지 않는다', async () => {
    let resolveResponse: (() => void) | null = null;
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveResponse = () => resolve({ ok: true, json: async () => ({}) });
        });
      }
      if (url.includes('status=pending')) return { ok: true, json: async () => [lowRiskActionable()] };
      return { ok: true, json: async () => [] };
    }));
    await mount();

    const approveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateApprove)) as HTMLButtonElement;
    await act(async () => { approveButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(approveButton.disabled).toBe(true);
    // 응답 오기 전 재클릭 — disabled라 브라우저가 클릭을 무시하지만, 방어적으로 핸들러를
    // 직접 다시 불러도 두 번째 POST가 안 나가야 한다는 것까지 확認하진 않는다(React가 disabled
    // 버튼 클릭 이벤트 자체를 억제 — jsdom도 동일). 여기선 "그 시점까지 POST가 1건뿐"만 고정.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    await act(async () => { resolveResponse?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.cage.queueResolvedApproved);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('반려 클릭 시 status=rejected로 호출하고 반려됨 배지를 보인다', async () => {
    const calls = mockFetches([lowRiskActionable({ id: 'g-rej' })], []);
    await mount();
    const rejectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateReject));
    await act(async () => { rejectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const postCall = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(postCall?.body ?? '{}')).toEqual({ status: 'rejected', note: null });
    expect(container.textContent).toContain(koMessages.cage.queueResolvedRejected);
  });

  it('서버가 거부하면(예: 이미 처리됨) 에러 문구를 보이고 완료 상태로 바뀌지 않는다(버튼 그대로 재시도 가능)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: { message: '이미 처리된 게이트입니다' } }) };
      }
      if (url.includes('status=pending')) return { ok: true, json: async () => [lowRiskActionable()] };
      return { ok: true, json: async () => [] };
    }));
    await mount();
    const approveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('이미 처리된 게이트입니다');
    expect(container.textContent).not.toContain(koMessages.cage.queueResolvedApproved);
    const buttonsAfter = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttonsAfter.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
  });

  it('held gate는 저위험이어도 인라인 버튼이 안 뜬다(보류 상태는 원탭 대상 아님)', async () => {
    mockFetches([], [lowRiskActionable({ id: 'g-held-low', status: 'held' })]);
    await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  // PO 리뷰(PR#2948, 2026-08-12) — status는 여전히 'pending'인데 held_until만 세팅된 조합.
  // isHeld는 held_until만으로도 true라 보류 배지가 뜨는데, canInlineResolve가 그걸 안 보면
  // "보류 뱃지 + 원탭 승인 버튼"이 같은 카드에 동시에 뜨는 자기모순이 난다.
  it('pending 상태에 held_until만 세팅돼도 인라인 버튼이 안 뜬다(보류 배지·원탭 버튼 공존 봉쇄)', async () => {
    mockFetches([lowRiskActionable({ id: 'g-pending-held-until', held_until: new Date().toISOString() })], []);
    await mount();
    expect(container.textContent).toContain(koMessages.cage.heldBadge);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  // PO 리뷰(PR#2948, 2026-08-12) — resolving이 단일 string|null이던 시절엔 게이트 A in-flight
  // 중 A가 먼저 끝나면 finally의 setResolving(null)이 "전역" 값을 지워, 아직 in-flight인
  // B의 버튼까지 재활성화됐다(중복 POST 창). id별 Set으로 독립 추적해야 한다는 걸 두 게이트를
  // 동시에 굴려서 고정한다.
  it('AC "중복 실행 0"(다중 게이트) — 게이트 A가 먼저 끝나도 아직 진행 중인 게이트 B 버튼은 계속 비활성 상태다', async () => {
    const calls: { url: string; method?: string }[] = [];
    let resolveA: (() => void) | null = null;
    let resolveB: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      if (init?.method === 'POST' && url.includes('g-a')) {
        return new Promise((resolve) => { resolveA = () => resolve({ ok: true, json: async () => ({}) }); });
      }
      if (init?.method === 'POST' && url.includes('g-b')) {
        return new Promise((resolve) => { resolveB = () => resolve({ ok: true, json: async () => ({}) }); });
      }
      if (url.includes('status=pending')) {
        return { ok: true, json: async () => [lowRiskActionable({ id: 'g-a' }), lowRiskActionable({ id: 'g-b' })] };
      }
      return { ok: true, json: async () => [] };
    }));
    await mount();

    // React가 두 카드의 위치/구조를 그대로 유지하는 한(g-b는 이 테스트 내내 in-flight 2버튼
    // 레이아웃을 벗어나지 않는다) DOM 참조는 재조회 없이도 재렌더를 관통해 유효하다 — B가
    // "..."로 라벨만 바뀌는 것과 무관하게 같은 버튼 엘리먼트를 계속 가리킨다.
    const [approveA, approveB] = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.includes(koMessages.cage.gateApprove)) as HTMLButtonElement[];
    await act(async () => { approveA.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { approveB.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);

    // A만 먼저 끝난다 — B는 여전히 in-flight.
    await act(async () => { resolveA?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(approveB.disabled).toBe(true);
    await act(async () => { approveB.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2); // B 재클릭이 세 번째 POST를 못 만든다.

    await act(async () => { resolveB?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(container.textContent).toContain(koMessages.cage.queueResolvedApproved);
  });
});
