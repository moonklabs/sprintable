// @vitest-environment jsdom
//
// story #2091(P0) — 오르테가군이 라이브에서 직접 재현: gate.can_approve=false(에이전트 계정,
// BE per-caller 판정)인데도 화면이 승인/반려 버튼을 열어 클릭 시 서버가 403으로 거부했다.
// "API가 틀렸나 화면이 틀렸나"의 답은 화면 — needsAction(게이트 자체가 사람 판단이 필요한가)과
// can_approve(이 caller가 승인 권한이 있는가)를 섞어서 버튼을 열었다. AC②(권한 없는 계정에서
// 버튼이 안 열리는 것도 반드시 같이 본다 — 한쪽만 보면 "항상 true" 수정도 통과한다)에 따라
// can_approve=true/false 양쪽 다 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';

const { useDashboardContextMock, replaceMock, muxSubscribeMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  replaceMock: vi.fn(),
  muxSubscribeMock: vi.fn((_eventName: string, _handler: (raw: string, eventId?: string) => void) => () => {}),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useParams: () => ({ id: 'gate-1' }),
}));

// story #2985 AC2 — approval-request-card.test.tsx와 동일 전략: useSseMultiplexerContext()
// 훅을 모킹해 subscribe 핸들러를 테스트가 직접 잡아 fire한다.
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ subscribe: muxSubscribeMock }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, Provider: React.ComponentType<{ children: React.ReactNode }>) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Provider>{node}</Provider>
    </NextIntlClientProvider>
  );
}

function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1',
    org_id: 'org-1',
    work_item_id: 'w-1',
    work_item_type: 'story',
    gate_type: 'merge_gate',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    requires_human: true,
    // usesSignatureFlow(riskLevel!=='low')는 'unknown'/'high'에서 GateSignatureApproval(다른
    // 버튼 라벨·sigApproveAndSign/sigRequestChanges)로 분기한다 — can_approve 게이팅 자체를
    // 테스트하는 이 스위트는 그 분기 디테일과 무관하므로 'low'로 고정해 단순 버튼 경로를 탄다.
    risk_grade: 'low',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgMemberships: [], projectMemberships: [] });
  muxSubscribeMock.mockClear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  replaceMock.mockReset();
});

async function mount(gateFixture: GateItem) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/gates/gate-1') return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
  const { default: GateDetailPage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('GateDetailPage — can_approve 게이팅 (story #2091)', () => {
  it('can_approve=true면 승인/반려 버튼이 렌더된다', async () => {
    await mount(gate({ can_approve: true }));
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(true);
  });

  it('can_approve=false면(에이전트 계정 등) 승인/반려 버튼이 렌더되지 않고 권한없음 문구가 뜬다', async () => {
    await mount(gate({ can_approve: false }));
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateReject))).toBe(false);
    expect(container.textContent).toContain(koMessages.cage.gateReadonlyNotAuthorized);
  });

  it('can_approve가 응답에 없으면(구버전/누락) undefined→false로 안전하게 폴백해 버튼을 안 연다(fail-closed)', async () => {
    const g = gate({});
    delete (g as { can_approve?: boolean }).can_approve;
    await mount(g);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });

  // story #3006(유나 design 관찰, 페드루 확定 2026-08-24) — can_approve=false가 "무권한"과
  // "지정 결재선이 걸려 있음(그저 내가 아님)"을 뭉뚱그리던 것을 갈라 문맥을 회복한다.
  it('can_approve=false + designated_approver_id가 나(currentTeamMemberId) 아니면 "지정됨" 문구로 분기한다', async () => {
    useDashboardContextMock.mockReturnValue({
      orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'member-1',
    });
    await mount(gate({ can_approve: false, designated_approver_id: 'member-2' }));
    expect(container.textContent).toContain(koMessages.cage.gateReadonlyDesignatedElsewhere);
    expect(container.textContent).not.toContain(koMessages.cage.gateReadonlyNotAuthorized);
  });

  it('can_approve=false + designated_approver_id가 없으면(일반 게이트) 기존 일반 무권한 문구 그대로(회귀 0)', async () => {
    useDashboardContextMock.mockReturnValue({
      orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'member-1',
    });
    await mount(gate({ can_approve: false, designated_approver_id: null }));
    expect(container.textContent).toContain(koMessages.cage.gateReadonlyNotAuthorized);
    expect(container.textContent).not.toContain(koMessages.cage.gateReadonlyDesignatedElsewhere);
  });

  it('can_approve=false + designated_approver_id가 나 자신이면(예: 프로젝트 접근을 잃은 지정자) 일반 무권한 문구(지정 사실이 이유가 아님)', async () => {
    useDashboardContextMock.mockReturnValue({
      orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'member-1',
    });
    await mount(gate({ can_approve: false, designated_approver_id: 'member-1' }));
    expect(container.textContent).toContain(koMessages.cage.gateReadonlyNotAuthorized);
    expect(container.textContent).not.toContain(koMessages.cage.gateReadonlyDesignatedElsewhere);
  });

  it('needsAction 자체가 false(예: block 판정)면 can_approve=true여도 버튼이 없다(게이트가 액션을 요구하지 않음)', async () => {
    await mount(gate({ can_approve: true, auto_decision_reason: 'block' }));
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });
});

// story #2500 — `body.detail`은 실 envelope({data,error,meta})에 없는 필드라 이 분기는
// 항상 죽어있었다(그라운딩 확認) — #2027의 "고위험 승인 사유 필수" 서버 거부 문구가 한 번도
// 실제로 화면에 뜬 적 없이 항상 "HTTP 422"만 보였다. error.message로 교정.
describe('GateDetailPage — transition 실패 사유 노출 (story #2500)', () => {
  it('422 거부 사유(#2027 고위험 승인 사유 필수)가 raw "HTTP 422" 대신 실 메시지로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/gates/gate-1' && !init) return { ok: true, status: 200, json: async () => ({ data: gate({ can_approve: true, risk_grade: 'low' }) }) };
      if (url === '/api/gates/gate-1/transition') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ data: null, error: { code: 'UNPROCESSABLE_ENTITY', message: '고위험(risk_grade=high) 게이트 승인은 사유(note) 입력이 필수입니다.' }, meta: null }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('HTTP 422');
    expect(container.textContent).toContain('고위험(risk_grade=high) 게이트 승인은 사유(note) 입력이 필수입니다.');
  });

  // story #2552 — BE가 사람이 읽을 message를 안 주는 예외(네트워크·예상외 500 등)엔 raw
  // "HTTP {status}"가 아니라 사람말 공통 폴백(gateTransitionErrorGeneric)을 보여준다.
  it('BE가 message를 안 주면(500 등) raw "HTTP 500" 대신 사람말 폴백을 보여준다 (story #2552)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/gates/gate-1' && !init) return { ok: true, status: 200, json: async () => ({ data: gate({ can_approve: true, risk_grade: 'low' }) }) };
      if (url === '/api/gates/gate-1/transition') {
        return { ok: false, status: 500, json: async () => ({ data: null, error: null, meta: null }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('HTTP 500');
    expect(container.textContent).toContain(koMessages.cage.gateTransitionErrorGeneric);
  });

  // story #2975(PO 요구 ①②③, 2026-08-24) — merge 게이트 승인 anchor SHA 레이스 근본처방.
  // BE가 409(code=gate_head_changed)로 거부하면 화면은 옛 SHA를 보여준 채 멈추지 않고
  // gate를 재조회(fetchGate)해 최신 상태로 재렌더해야 「새 커밋 도착·재확認」이 실제로 된다.
  it('409 gate_head_changed 거부 시 사유를 보여주고 gate를 재조회한다', async () => {
    let gateFetchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/gates/gate-1' && !init) {
        gateFetchCount += 1;
        const sha = gateFetchCount === 1 ? 'sha-old-reviewed' : 'sha-new-race-landed';
        return { ok: true, status: 200, json: async () => ({ data: gate({ can_approve: true, risk_grade: 'low', github_check_run_sha: sha }) }) };
      }
      if (url === '/api/gates/gate-1/transition') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            data: null,
            error: { code: 'gate_head_changed', message: '게이트 대상 커밋이 승인 확인 이후 변경되었습니다. 최신 내용을 다시 확인한 뒤 승인해주세요.', current_head_sha: 'sha-new-race-landed' },
            meta: null,
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('게이트 대상 커밋이 승인 확인 이후 변경되었습니다');
    expect(gateFetchCount).toBe(2); // 최초 로드(1) + 409 이후 재조회(2) — 화면이 옛 SHA에 안 멈춘다.
  });

  // story #2975(유나양 design 판정 2026-08-24, PO 확定) — 409→fetchGate() 재조회 後
  // GateSignatureApproval의 evidenceViewed/reason state가 안 리셋되면 canSign이 그대로 true라
  // PO가 새 SHA(B)를 실제로 안 보고도 재승인 버튼을 바로 누를 수 있었다(서버가 막은 "리뷰
  // 안 한 SHA 승인"이 UX 층에서 뚫림). key={github_check_run_sha}로 SHA 변경 시 강제 remount
  // 해 열람 체크·사유가 초기화되는지 — 「새 SHA 열람 前 canSign=false」를 직접 증명한다.
  it('409 재조회로 SHA가 바뀌면 근거열람 체크·사유가 리셋돼 재승인 버튼이 다시 비활성화된다', async () => {
    let gateFetchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/gates/gate-1' && !init) {
        gateFetchCount += 1;
        const sha = gateFetchCount === 1 ? 'sha-A-reviewed' : 'sha-B-race-landed';
        return { ok: true, status: 200, json: async () => ({ data: gate({ can_approve: true, risk_grade: 'high', github_check_run_sha: sha }) }) };
      }
      if (url === '/api/gates/gate-1/transition') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            data: null,
            error: { code: 'gate_head_changed', message: 'SHA changed', current_head_sha: 'sha-B-race-landed' },
            meta: null,
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // SHA A 열람: 체크+사유 입력 → 서명 버튼이 활성화됨을 먼저 확인(사전조건).
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'SHA A 검토 완료');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let signBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.sigApproveAndSign));
    expect(signBtn?.disabled).toBe(false);

    // 승인 클릭 → 409(SHA B로 바뀜) → fetchGate() 재조회 → key 변경으로 강제 remount.
    await act(async () => { signBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(gateFetchCount).toBe(2);
    const checkboxAfter = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkboxAfter.checked).toBe(false); // remount로 evidenceViewed 리셋 확認.
    signBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.sigApproveAndSign));
    expect(signBtn?.disabled).toBe(true); // canSign=false — 새 SHA B를 실제로 다시 봐야만 재활성화.
  });
});

// story #2631(FE 계약 doc bb733f26) — 「보류(논의 필요)」+ 오클릭 정정(취소). 저위험 경로
// 버튼 노출·엔드포인트 배선만 고정한다(다이얼로그·GateUndoButton 자체의 상세 동작은
// approvals-queue.test.tsx가 이미 실 렌더로 커버 — 공유 컴포넌트 중복 검증 금지, 여기선
// "이 페이지가 올바른 props로 그것들을 배선했는가"만 본다).
describe('GateDetailPage — 보류(논의 필요)·오클릭 정정 (story #2631)', () => {
  async function mountWithMutations(gateFixture: GateItem, extra?: { discussOk?: boolean; undoOk?: boolean }) {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url === '/api/gates/gate-1' && !init) return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
      if (url === '/api/gates/gate-1/discuss') {
        return (extra?.discussOk ?? true)
          ? { ok: true, json: async () => ({ data: gateFixture }) }
          : { ok: false, status: 422, json: async () => ({ error: { message: '사유가 필요합니다' } }) };
      }
      if (url === '/api/gates/gate-1/undo') {
        return (extra?.undoOk ?? true)
          ? { ok: true, json: async () => ({ data: { ...gateFixture, status: 'pending', resolver_id: null, resolved_at: null } }) }
          : { ok: false, status: 403, json: async () => ({ error: { message: '해소자 본인만 취소할 수 있습니다' } }) };
      }
      if (url === '/api/gates/gate-1') return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    return calls;
  }

  it('저위험 pending 게이트엔 승인/반려 옆에 「보류(논의 필요)」 버튼이 뜬다', async () => {
    await mountWithMutations(gate({ can_approve: true }));
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateDiscussSubmit))).toBe(true);
  });

  it('「보류(논의 필요)」 사유 제출 시 POST /api/gates/{id}/discuss를 {reason}으로 호출한다', async () => {
    const calls = await mountWithMutations(gate({ can_approve: true }));
    const discussTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateDiscussSubmit));
    await act(async () => { discussTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const textarea = document.body.querySelector('[data-slot="dialog-content"] textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '근거 확인 후 재판단');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitButton = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.cage.gateDiscussSubmit) as HTMLButtonElement;
    await act(async () => { submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const discussCall = calls.find((c) => c.url === '/api/gates/gate-1/discuss');
    expect(discussCall?.method).toBe('POST');
    expect(JSON.parse(discussCall?.body ?? '{}')).toEqual({ reason: '근거 확인 후 재판단' });
  });

  it('본인이 방금 해소한 게이트(5분 이내)엔 취소 버튼이 뜨고, 클릭 시 POST /undo를 호출한다', async () => {
    useDashboardContextMock.mockReturnValue({ orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'me-1' });
    const resolvedJustNow = gate({ status: 'approved', resolver_id: 'me-1', resolved_at: new Date().toISOString() });
    const calls = await mountWithMutations(resolvedJustNow);
    const undoButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateUndo));
    expect(undoButton).toBeTruthy();
    await act(async () => { undoButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(calls.some((c) => c.url === '/api/gates/gate-1/undo' && c.method === 'POST')).toBe(true);
  });

  it('타인이 해소한 게이트엔 취소 버튼이 안 뜬다(본인만, SoD류 오용 방지)', async () => {
    useDashboardContextMock.mockReturnValue({ orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'me-1' });
    const resolvedByOther = gate({ status: 'approved', resolver_id: 'someone-else', resolved_at: new Date().toISOString() });
    await mountWithMutations(resolvedByOther);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateUndo))).toBe(false);
  });

  it('5분 창이 지난 게이트엔 취소 버튼이 안 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({ orgMemberships: [], projectMemberships: [], currentTeamMemberId: 'me-1' });
    const staleResolved = gate({ status: 'approved', resolver_id: 'me-1', resolved_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() });
    await mountWithMutations(staleResolved);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateUndo))).toBe(false);
  });
});

// story #2027 AC2(페드루 PO 처방 2026-08-16) — BE가 고위험(risk_grade=high) 게이트 승인에
// evidence_viewed=true를 강제하기 시작했다. FE가 이 값을 안 보내면 서명 플로우를 거쳐도
// 서버가 422로 막는다 — 이 스위트는 "서명 플로우를 거치면 실제로 true가 실리는지"와
// "저위험 플레인 버튼은 안 실려도(false) 무관한지" 둘 다 고정한다.
describe('GateDetailPage — evidence_viewed 서버 계약 (story #2027 AC2)', () => {
  async function mountCapturingTransition(gateFixture: GateItem) {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url === '/api/gates/gate-1' && !init) return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
      if (url === '/api/gates/gate-1/transition') return { ok: true, json: async () => ({ data: gateFixture }) };
      if (url === '/api/gates/gate-1') return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    return calls;
  }

  it('고위험(서명 플로우) 승인 — 근거 열람 체크 + 사유 입력 후 클릭하면 evidence_viewed:true가 실린다', async () => {
    const calls = await mountCapturingTransition(gate({ can_approve: true, risk_grade: 'high' }));

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const textarea = container.querySelector('#gate-sig-reason') as HTMLTextAreaElement;
    expect(checkbox).toBeTruthy();
    expect(textarea).toBeTruthy();

    await act(async () => { checkbox.click(); });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '근거 확인함');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.sigApproveAndSign));
    expect(approveBtn?.hasAttribute('disabled')).toBe(false);
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const transitionCall = calls.find((c) => c.url === '/api/gates/gate-1/transition');
    expect(JSON.parse(transitionCall?.body ?? '{}')).toMatchObject({ status: 'approved', evidence_viewed: true });
  });

  it('저위험(플레인 버튼) 승인 — evidence_viewed:false로 실려도(안 봤어도) 그대로 통과 경로(회귀 없음)', async () => {
    const calls = await mountCapturingTransition(gate({ can_approve: true, risk_grade: 'low' }));
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const transitionCall = calls.find((c) => c.url === '/api/gates/gate-1/transition');
    expect(JSON.parse(transitionCall?.body ?? '{}')).toMatchObject({ status: 'approved', evidence_viewed: false });
  });
});

// story P0-02(PR#3367 2026-08-22) — gate_type "chip" 배지에 처음엔 이 지점만 className
// 오버라이드(text-foreground)로 처방했다. ⚠️정정(2026-08-22, 유나 재검산·codex 교차확인) —
// 당시 인용된 "3.55(AA 미달)"는 측정 아티팩트(bg-blend 버그)로 판명, 실측은 5.20/5.65로
// 이미 AA 통과였다 — #3367은 「위반 수정」이 아니라 「#2420 캐논 규칙(tint 배경 위 글자=
// text-foreground) 정합」이었다. story #2937(PR#3372)로 chip variant 기본 자체가
// text-foreground로 이행 — 지점 오버라이드는 걷었고(badge.tsx가 이제 이 값을 자동으로
// 준다), 이 가드는 그대로 유지(회귀 시 잡아냄).
describe('GateDetailPage — gate_type 배지 대비(P0-02, chip variant 기본으로 승계·#2937)', () => {
  it('gate_type 배지가 text-foreground를 쓴다(chip variant 기본값 — #2937 이후 지점 오버라이드 불요)', async () => {
    await mount(gate({ gate_type: 'merge_gate' }));
    const chipEl = [...container.querySelectorAll('span')].find((el) => el.textContent === 'merge_gate');
    expect(chipEl, 'gate_type 배지를 못 찾음').toBeDefined();
    expect(chipEl!.className).toContain('text-foreground');
    expect(chipEl!.className).not.toContain('text-muted-foreground');
  });
});

describe('GateDetailPage — 실시간 해소 반영(story #2985 AC2)', () => {
  it('mux가 conversation.gate_resolved(같은 gate_id)를 쏘면 재조회된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/gates/gate-1') {
        getCount += 1;
        return { ok: true, status: 200, json: async () => ({ data: gate({ status: 'pending' }) }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    expect(call).toBeTruthy();
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'gate-1', status: 'approved' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(2); // 새로고침 없이 재조회.
  });

  it('다른 gate_id의 이벤트는 무시한다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/gates/gate-1') {
        getCount += 1;
        return { ok: true, status: 200, json: async () => ({ data: gate({ status: 'pending' }) }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'other-gate', status: 'approved' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(1);
  });

  it('mux가 conversation.gate_delegated(같은 gate_id)를 쏘면 재조회된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/gates/gate-1') {
        getCount += 1;
        return { ok: true, status: 200, json: async () => ({ data: gate({ status: 'pending' }) }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_delegated');
    expect(call).toBeTruthy();
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'gate-1', new_approver_id: 'member-3' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(2);
  });

  it('malformed payload는 크래시 없이 무시한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/gates/gate-1') return { ok: true, status: 200, json: async () => ({ data: gate({ status: 'pending' }) }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    const handler = call![1] as (raw: string, eventId?: string) => void;
    expect(() => handler('not-json{')).not.toThrow();
  });
});

// story #3113(실사고·선생님 2026-08-26) — 상세 페이지에서도 결정 게이트(agent_decision_
// request)의 question/assumption/options가 전문 열람 가능해야 한다(#3038이 고친 건 merge
// 카드 렌더뿐, 이 gate_type은 미커버였다).
describe('GateDetailPage — story #3113 결정 게이트(agent_decision_request) 전문 열람', () => {
  function decisionGate(overrides: Partial<GateItem> = {}): GateItem {
    return gate({
      gate_type: 'agent_decision_request', can_approve: true, risk_grade: 'low',
      neutral_facts: {
        question: 'Apple Developer Program 등록 — 유형을 어느 쪽으로?',
        assumption: 'PO 권고=A',
        options: ['A) Organization', 'B) Individual', 'C) 보류'],
      },
      ...overrides,
    });
  }

  it('claim(제목)에 question이 뜨고, 해시는 보조 캡션으로 강등된다', async () => {
    await mount(decisionGate());
    expect(container.textContent).toContain('Apple Developer Program 등록 — 유형을 어느 쪽으로?');
    expect(container.textContent).toContain('#w-1');
  });

  it('AC2 — assumption·options 전문이 (펼치기 없이) 상세 페이지엔 항상 보인다', async () => {
    await mount(decisionGate());
    expect(container.textContent).toContain('PO 권고=A');
    expect(container.textContent).toContain('A) Organization');
    expect(container.textContent).toContain('B) Individual');
    expect(container.textContent).toContain('C) 보류');
  });

  it('AC2 — 이미 해소된(approved) 결정 게이트도 전문이 그대로 남아 감사 가능하다', async () => {
    await mount(decisionGate({ status: 'approved', resolver_id: null }));
    expect(container.textContent).toContain('PO 권고=A');
    expect(container.textContent).toContain('A) Organization');
  });

  async function mountCapturingDecisionTransition(gateFixture: GateItem) {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url === '/api/gates/gate-1/transition') return { ok: true, json: async () => ({ data: gateFixture }) };
      if (url === '/api/gates/gate-1') return { ok: true, status: 200, json: async () => ({ data: gateFixture }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { default: GateDetailPage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<GateDetailPage />, TopBarProvider)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    return calls;
  }

  it('AC3 — options가 있으면 안을 고르기 전엔 승인 버튼이 비활성이고, 고르면 활성화된다', async () => {
    await mountCapturingDecisionTransition(decisionGate());
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove)) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(container.textContent).toContain(koMessages.cage.decisionSelectHint);

    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(3);
    await act(async () => { (radios[0] as HTMLInputElement).click(); });
    expect(approveBtn.disabled).toBe(false);
  });

  it('AC3 — 승인 시 선택안이 note로 전송·영구 기록된다(resolution_note)', async () => {
    const calls = await mountCapturingDecisionTransition(decisionGate());
    const radios = container.querySelectorAll('input[type="radio"]');
    await act(async () => { (radios[2] as HTMLInputElement).click(); });

    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove)) as HTMLButtonElement;
    await act(async () => { approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const transitionCall = calls.find((c) => c.url === '/api/gates/gate-1/transition');
    const body = JSON.parse(transitionCall?.body ?? '{}') as { status: string; note: string | null };
    expect(body.status).toBe('approved');
    expect(body.note).toBe('선택: C) 보류');
  });

  it('options가 없으면 승인 버튼이 곧바로 활성이다(선택 강요 없음)', async () => {
    await mountCapturingDecisionTransition(decisionGate({ neutral_facts: { question: '확인만 부탁' } }));
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.cage.gateApprove)) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
  });
});

// story #3128(#3113의 doc_approval판, 페드루 PO 3529 라이브 검증 중 부수 발견) — 「내용으로
// 직접 판단」하라면서 대상 문서/아티팩트로 가는 경로가 카드 어디에도 없던 결함.
describe('GateDetailPage — story #3128 대상 실물 진입 경로', () => {
  it('doc_approval + work_item_summary.slug가 있으면 원문 링크가 /docs/{slug}로 뜬다', async () => {
    await mount(gate({
      gate_type: 'doc_approval', work_item_type: 'doc', can_approve: true, risk_grade: 'low',
      work_item_summary: { title: '온보딩 재실측', slug: 'onboarding-remeasure' },
    }));
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.cage.gateDetailViewTargetDoc);
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/docs/onboarding-remeasure');
  });

  it('doc_approval인데 slug가 없으면(예외적 미해소) 링크를 렌더하지 않는다(없는 경로를 지어내지 않음)', async () => {
    await mount(gate({
      gate_type: 'doc_approval', work_item_type: 'doc', can_approve: true, risk_grade: 'low',
      work_item_summary: null,
    }));
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetDoc);
  });

  it('artifact_canonicalize는 work_item_summary 없이도 work_item_id로 /artifacts/{id} 링크가 뜬다', async () => {
    await mount(gate({
      gate_type: 'artifact_canonicalize', work_item_type: 'visual_artifact', work_item_id: 'artifact-42',
      can_approve: true, risk_grade: 'low', work_item_summary: null,
    }));
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.cage.gateDetailViewTargetArtifact);
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/artifacts/artifact-42');
  });

  it('doc/artifact가 아닌 다른 gate 유형(merge 등)은 대상 링크를 렌더하지 않는다(엉뚱한 경로 지어내지 않음)', async () => {
    // PO AC 리뷰(PR#3542) 사소 지적 — 'merge'가 실존 gate_type(hitl_config.py GATE_TYPES).
    // 'merge_gate'는 이 파일 기존 기본 픽스처값(line 57)일 뿐 실존 타입 아님 — 내 신규
    // 테스트는 정확한 값으로.
    await mount(gate({ gate_type: 'merge', work_item_type: 'story', can_approve: true, risk_grade: 'low' }));
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetDoc);
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetArtifact);
  });

  // story #3134(#3128 전수점검 잔여) — loop_decision의 work_item_id는 LoopRun.id, `/loops/{id}`가
  // 실 상세 페이지.
  it('loop_decision은 work_item_id로 /loops/{id} 링크가 뜬다', async () => {
    await mount(gate({
      gate_type: 'loop_decision', work_item_type: 'loop', work_item_id: 'loop-7',
      can_approve: true, risk_grade: 'low', work_item_summary: null,
    }));
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.cage.gateDetailViewTargetLoop);
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/loops/loop-7');
  });

  it('workflow_config_publish는 이번에도 대상 링크가 없다(실 뷰어 부재 — 억지 진입점 금지, #2118 AC④)', async () => {
    await mount(gate({
      gate_type: 'workflow_config_publish', work_item_type: 'wf_line_version', work_item_id: 'wf-9',
      can_approve: true, risk_grade: 'low', work_item_summary: null,
    }));
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetDoc);
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetArtifact);
    expect(container.textContent).not.toContain(koMessages.cage.gateDetailViewTargetLoop);
  });

  it('이미 해소된(approved) doc 게이트도 원문 링크가 그대로 남는다(감사 가치는 액션 여부와 무관 — decisionFacts·GateActivityHistory와 동원칙)', async () => {
    await mount(gate({
      gate_type: 'doc_approval', work_item_type: 'doc', status: 'approved', resolver_id: null,
      work_item_summary: { title: '온보딩 재실측', slug: 'onboarding-remeasure' },
    }));
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.cage.gateDetailViewTargetDoc);
    expect(link).toBeTruthy();
  });
});
