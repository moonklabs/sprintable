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
