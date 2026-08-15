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

const { useDashboardContextMock, replaceMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useParams: () => ({ id: 'gate-1' }),
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
