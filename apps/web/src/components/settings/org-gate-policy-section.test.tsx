// @vitest-environment jsdom
//
// story e0c1b24c — org 게이트 정책(posture·merge_gate_default_approver_member_id) 설정 UI.
// two-factor-section.test.tsx와 동형 harness(NextIntlClientProvider+createRoot+jsdom,
// global fetch stub — fetchWithAuth는 내부에서 fetch를 그대로 위임하므로 이 방식으로 충분).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OrgGatePolicySection } from './org-gate-policy-section';
import { ORG_NAMES_URL, resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

// [SID:4300] 기본 org 없음(조직 보충 안 함 — 기존 테스트 그대로). 보충 테스트만 orgId를 채운다.
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));
import koMessages from '../../../messages/ko.json';

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
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  dashCtx.value = {};
  resetOrgMembersCacheForTests();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ELIGIBLE_APPROVERS = {
  data: [
    { id: 'member-1', user_id: 'u1', name: '송윤재', email: 'iamyoonjae@moonklabs.com', role: 'owner' },
    { id: 'member-2', user_id: 'u2', name: '페드루', email: 'pedro@moonklabs.com', role: 'admin' },
  ],
};

function stubFetch(policyData: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/gate-config/policy' && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ({ data: policyData, error: null, meta: null }) };
      }
      if (url === '/api/org-members/eligible-approvers') {
        return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
      }
      throw new Error('unexpected fetch: ' + url + ' ' + (init?.method ?? 'GET'));
    }),
  );
}

describe('OrgGatePolicySection — 조회(story e0c1b24c)', () => {
  it('정책 미설정(null) — posture는 기본값 balanced·승인자는 미지정으로 표시(읽기전용)', async () => {
    stubFetch(null);
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit={false} />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.orgGatePolicy.postureBalanced);
    expect(container.textContent).toContain(koMessages.orgGatePolicy.approverUnset);
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('정책 설정됨 — posture·승인자 표시이름(이메일 병기)이 정확히 반영된다', async () => {
    stubFetch({
      id: 'p1', org_id: 'o1', posture: 'conservative',
      merge_gate_default_approver_member_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
    });
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit={false} />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.orgGatePolicy.postureConservative);
    expect(container.textContent).toContain('송윤재 (iamyoonjae@moonklabs.com)');
  });

  it('canEdit=true — 승인자 드롭다운 트리거가 현재 지정된 승인자 표시이름을 초기값으로 보여준다', async () => {
    stubFetch({
      id: 'p1', org_id: 'o1', posture: 'balanced',
      merge_gate_default_approver_member_id: 'member-2',
      created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
    });
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit />));
    });
    await flush();

    const triggerBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('페드루'),
    );
    expect(triggerBtn).toBeDefined();
  });

  it('⭐story #4083 — 레시피 게이트 기본 승인자 라벨·값이 머지 필드와 독립적으로 표시된다', async () => {
    stubFetch({
      id: 'p1', org_id: 'o1', posture: 'balanced',
      merge_gate_default_approver_member_id: null,
      recipe_gate_default_approver_member_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
    });
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit={false} />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.orgGatePolicy.recipeApproverLabel);
    expect(container.textContent).toContain('송윤재 (iamyoonjae@moonklabs.com)');
    // 머지 필드는 미지정 그대로 — 두 필드가 서로 안 섞임.
    expect(container.textContent).toContain(koMessages.orgGatePolicy.approverUnset);
  });
});

describe('OrgGatePolicySection — 저장(story e0c1b24c)', () => {
  it('⭐posture 버튼 클릭 → 저장 → PUT body가 새 posture를 정확히 싣는다', async () => {
    stubFetch(null);
    let putBody: unknown;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/gate-config/policy' && init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body));
          return { ok: true, status: 200, json: async () => ({ data: { posture: 'permissive' }, error: null, meta: null }) };
        }
        if (url === '/api/gate-config/policy') {
          return { ok: true, status: 200, json: async () => ({ data: null, error: null, meta: null }) };
        }
        if (url === '/api/org-members/eligible-approvers') {
          return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    );
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit />));
    });
    await flush();

    const permissiveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.orgGatePolicy.posturePermissive,
    );
    expect(permissiveBtn).toBeDefined();
    await act(async () => {
      permissiveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.orgGatePolicy.save,
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(putBody).toEqual({
      posture: 'permissive',
      merge_gate_default_approver_member_id: null,
      recipe_gate_default_approver_member_id: null,
    });
    expect(container.textContent).toContain(koMessages.orgGatePolicy.saved);
  });

  it('⭐story #4083 — 기존 레시피 승인자 지정값이 변경 없이 저장해도 PUT body에 그대로 유지된다', async () => {
    stubFetch({
      id: 'p1', org_id: 'o1', posture: 'balanced',
      merge_gate_default_approver_member_id: null,
      recipe_gate_default_approver_member_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
    });
    let putBody: unknown;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/gate-config/policy' && init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body));
          return { ok: true, status: 200, json: async () => ({ data: { posture: 'balanced' }, error: null, meta: null }) };
        }
        if (url === '/api/gate-config/policy') {
          return {
            ok: true, status: 200,
            json: async () => ({
              data: {
                id: 'p1', org_id: 'o1', posture: 'balanced',
                merge_gate_default_approver_member_id: null,
                recipe_gate_default_approver_member_id: 'member-1',
                created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
              },
              error: null, meta: null,
            }),
          };
        }
        if (url === '/api/org-members/eligible-approvers') {
          return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    );
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit />));
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.orgGatePolicy.save,
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(putBody).toEqual({
      posture: 'balanced',
      merge_gate_default_approver_member_id: null,
      recipe_gate_default_approver_member_id: 'member-1',
    });
  });

  it('⭐422(에이전트 멤버 지정 등) — 백엔드 detail 문구가 화면에 그대로 나온다(지어내지 않음)', async () => {
    stubFetch(null);
    const detailMsg =
      'merge_gate_default_approver_member_id는 이 조직의 human owner/admin 멤버여야 합니다(에이전트는 requires_human 게이트에 서명할 수 없습니다).';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/gate-config/policy' && init?.method === 'PUT') {
          return { ok: false, status: 422, json: async () => ({ detail: detailMsg }) };
        }
        if (url === '/api/gate-config/policy') {
          return { ok: true, status: 200, json: async () => ({ data: null, error: null, meta: null }) };
        }
        if (url === '/api/org-members/eligible-approvers') {
          return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    );
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit />));
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.orgGatePolicy.save,
    );
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(detailMsg);
  });

  // story #4083(페드루 PO 리뷰, 2026-09-21) — merge 쪽(위 테스트)과 같은 raw passthrough
  // 관례(story e0c1b24c) 그대로 유지한다. 최초 처방은 이 필드만 FE 문자열 마커로 잡아
  // 별도 i18n 키로 치환했으나(반창고 — API/MCP 등 다른 클라이언트엔 여전히 내부어 문장이
  // 새고, FE는 문자열 마커에 매달림), 페드루 PO 재정정으로 뿌리(BE i18n_catalog.py의
  // 카탈로그 문구 자체)를 사람 문장으로 고쳤다 — FE는 다시 raw passthrough, 이 테스트는
  // 그 카탈로그 문구가 실제로 화면에 그대로(가공 없이) 뜨고 내부어가 안 섞였는지를 고정.
  it('⭐422(레시피 필드, 에이전트 멤버 지정) — BE 카탈로그 문구(사람 문장)가 raw로 그대로 뜬다(필드명·영문 내부 속성어 미노출)', async () => {
    stubFetch(null);
    const rawDetail = '레시피 게이트 기본 승인자는 이 조직의 소유자 또는 관리자(사람)만 지정할 수 있어요.';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/gate-config/policy' && init?.method === 'PUT') {
          return { ok: false, status: 422, json: async () => ({ detail: rawDetail }) };
        }
        if (url === '/api/gate-config/policy') {
          return { ok: true, status: 200, json: async () => ({ data: null, error: null, meta: null }) };
        }
        if (url === '/api/org-members/eligible-approvers') {
          return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    );
    await act(async () => {
      root.render(wrap(<OrgGatePolicySection canEdit />));
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.orgGatePolicy.save,
    );
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(rawDetail);
    expect(container.textContent).not.toContain('recipe_gate_default_approver_member_id');
    expect(container.textContent).not.toContain('requires_human');
  });
});

// [SID:4300] 지정 승인자가 후보(owner/admin · 고르는 목록)에 없을 때 — 역할이 바뀐 사람 등 — 조직 범위로 이름. 조직에도 없으면 «알 수 없는 구성원».
describe('OrgGatePolicySection — 후보 밖 지정 승인자 이름([SID:4300])', () => {
  function stubWithOrg(orgRows: Array<{ id: string; name: string | null; type: string }>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/gate-config/policy') {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', org_id: 'o1', posture: 'balanced', merge_gate_default_approver_member_id: 'member-9', created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }, error: null, meta: null }) };
      }
      if (url === '/api/org-members/eligible-approvers') return { ok: true, status: 200, json: async () => ELIGIBLE_APPROVERS };
      if (url === ORG_NAMES_URL) return { ok: true, status: 200, json: async () => ({ data: orgRows }) };
      throw new Error('unexpected fetch: ' + url);
    }));
  }

  it('후보 밖 지정 승인자 → 조직 이름', async () => {
    dashCtx.value = { orgId: 'org-1' };
    stubWithOrg([{ id: 'member-9', name: '전 관리자', type: 'human' }]);
    await act(async () => { root.render(wrap(<OrgGatePolicySection canEdit={false} />)); });
    await flush(); await flush();
    expect(container.textContent).toContain('전 관리자');
    expect(container.textContent).not.toContain('알 수 없는 구성원');
  });

  it('조직에도 없으면 «알 수 없는 구성원»', async () => {
    dashCtx.value = { orgId: 'org-1' };
    stubWithOrg([]);
    await act(async () => { root.render(wrap(<OrgGatePolicySection canEdit={false} />)); });
    await flush(); await flush();
    expect(container.textContent).toContain('알 수 없는 구성원');
  });
});
