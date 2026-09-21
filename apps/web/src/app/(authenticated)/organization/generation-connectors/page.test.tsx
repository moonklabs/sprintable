// @vitest-environment jsdom
//
// story #4116(#4112 유나 시안 55a04e8d) — 연산 커넥터 설정 화면 계약 핀.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const ORG_ID = 'org-1';

function asRole(role: 'owner' | 'admin' | 'member') {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role }],
    projectMemberships: [],
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  asRole('admin');
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: OrganizationGenerationConnectorsPage } = await import('./page');
  await act(async () => { root.render(wrap(<OrganizationGenerationConnectorsPage />)); });
  await flush();
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const CONNECTOR_ACTIVE = {
  id: 'gen-1', provider_key: 'vertex_gemini', label: '메인 연산 커넥터',
  model_config_json: { image: 'imagen-3', video: 'veo-2' }, status: 'active', created_by: 'm1',
};
const CONNECTOR_REVOKED = {
  id: 'gen-2', provider_key: 'vertex_gemini', label: '지난 캠페인 커넥터',
  model_config_json: {}, status: 'revoked', created_by: 'm1',
};

// React controlled input/textarea는 raw .value= 대입으로 onChange가 안 불린다(네이티브
// setter를 직접 불러야 함, pasted-secret-connect-card.test.tsx와 동일 관례).
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function stubList(connectors: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`) && (!init || init.method === undefined)) {
      return { ok: true, json: async () => ({ data: { connectors } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

describe('OrganizationGenerationConnectorsPage — 목록·권한(AC1)', () => {
  it('owner/admin — 목록 행(이름·provider 배지·상태칩)이 렌더되고 등록 버튼이 있다', async () => {
    stubList([CONNECTOR_ACTIVE, CONNECTOR_REVOKED]);
    await mount();

    const rows = document.body.querySelectorAll('[data-testid="gc-row"]');
    expect(rows.length).toBe(2);
    expect(document.body.textContent).toContain('메인 연산 커넥터');
    expect(document.body.textContent).toContain('vertex_gemini');
    expect(document.body.querySelector('[data-status-chip="active"]')).toBeTruthy();
    expect(document.body.querySelector('[data-status-chip="revoked"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="gc-register-action"]')).toBeTruthy();
    // 해지된 커넥터엔 해지 버튼이 없다(이미 revoked).
    expect(document.body.querySelector('[data-testid="gc-revoke-gen-2"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="gc-revoke-gen-1"]')).toBeTruthy();
  });

  it('일반 멤버 — 등록/해지 버튼 0 + 사유 한 줄, 목록은 그대로 보인다', async () => {
    asRole('member');
    stubList([CONNECTOR_ACTIVE]);
    await mount();

    expect(document.body.textContent).toContain('메인 연산 커넥터'); // 목록은 전원 열람.
    expect(document.body.querySelector('[data-testid="gc-register-action"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="gc-revoke-gen-1"]')).toBeNull();
    const reason = document.body.querySelector('[data-testid="gc-owner-only-reason"]');
    expect(reason?.textContent).toBe(koMessages.organization.gcOwnerOnlyReason);
  });

  it('빈 상태(0건) — owner/admin에겐 «첫 커넥터 등록» CTA', async () => {
    stubList([]);
    await mount();

    expect(document.body.textContent).toContain(koMessages.organization.gcEmptyTitle);
    expect(document.body.querySelector('[data-testid="gc-first-register-action"]')).toBeTruthy();
    // 목록이 비었을 땐 PageHeader의 일반 등록 버튼은 안 뜬다(빈 상태 CTA가 대신함).
    expect(document.body.querySelector('[data-testid="gc-register-action"]')).toBeNull();
  });

  it('목록 fetch 실패 — 에러+재시도, 재시도 성공하면 목록이 채워진다', async () => {
    let shouldFail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`)) {
        if (shouldFail) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: { connectors: [CONNECTOR_ACTIVE] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    await mount();

    expect(document.body.textContent).toContain(koMessages.organization.gcListLoadError);
    shouldFail = false;
    const retryBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventApplyAgentsRetry)!;
    await act(async () => { retryBtn.click(); });
    await flush();
    expect(document.body.textContent).toContain('메인 연산 커넥터');
  });
});

describe('OrganizationGenerationConnectorsPage — 등록 폼(AC2)', () => {
  it('제출 성공 — 폼이 닫히고 목록이 갱신된다', async () => {
    let created = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`) && init?.method === 'POST') {
        created = true;
        return { ok: true, json: async () => ({ data: CONNECTOR_ACTIVE }) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`)) {
        return { ok: true, json: async () => ({ data: { connectors: created ? [CONNECTOR_ACTIVE] : [] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    await mount();

    const registerBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-first-register-action"]')!;
    await act(async () => { registerBtn.click(); });
    await flush();
    expect(document.body.querySelector('[data-testid="gc-register-form"]')).toBeTruthy();

    const labelInput = document.body.querySelector<HTMLInputElement>('#gc-field-label')!;
    const credInput = document.body.querySelector<HTMLTextAreaElement>('#gc-field-credential')!;
    await act(async () => {
      setInputValue(labelInput, '메인 연산 커넥터');
      setInputValue(credInput, '{"type":"service_account"}');
    });

    const submitBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-register-submit"]')!;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(document.body.querySelector('[data-testid="gc-register-form"]')).toBeNull();
    expect(document.body.textContent).toContain('메인 연산 커넥터');
  });

  it('자격 칸은 성공/실패 무관 제출 뒤 비워진다(다시 못 봄)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`) && init?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ error: { code: 'UNPROCESSABLE_ENTITY' } }) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`)) {
        return { ok: true, json: async () => ({ data: { connectors: [] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    await mount();

    const registerBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-first-register-action"]')!;
    await act(async () => { registerBtn.click(); });
    await flush();

    const labelInput = document.body.querySelector<HTMLInputElement>('#gc-field-label')!;
    const credInput = document.body.querySelector<HTMLTextAreaElement>('#gc-field-credential')!;
    await act(async () => {
      setInputValue(labelInput, '메인 연산 커넥터');
      setInputValue(credInput, '{"type":"service_account"}');
    });
    const submitBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-register-submit"]')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(document.body.textContent).toContain(koMessages.organization.gcErrorProviderUnsupported);
    expect((document.body.querySelector<HTMLTextAreaElement>('#gc-field-credential'))?.value).toBe('');
  });
});

describe('OrganizationGenerationConnectorsPage — 해지 확認(AC2)', () => {
  it('확認 없이 revoke 호출 0 — 해지 버튼 클릭만으로는 POST가 안 나간다', async () => {
    const postCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { postCalls.push(url); return { ok: true, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ data: { connectors: [CONNECTOR_ACTIVE] } }) };
    }));
    await mount();

    const revokeBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-revoke-gen-1"]')!;
    await act(async () => { revokeBtn.click(); });
    await flush();

    expect(postCalls).toHaveLength(0); // 다이얼로그만 뜨고 아직 호출 0.
    // gcRevokeConfirmTitle 키 그대로: "{name}을(를) 해지할까요"(조사 자동 선택 없음, 원문 그대로).
    expect(document.body.textContent).toContain('메인 연산 커넥터을(를) 해지할까요');
  });

  it('확認 다이얼로그에서 해지를 누르면 revoke 엔드포인트를 호출하고 목록을 갱신한다', async () => {
    let revoked = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/organizations/${ORG_ID}/generation-connectors/gen-1/revoke` && init?.method === 'POST') {
        revoked = true;
        return { ok: true, json: async () => ({}) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/generation-connectors`)) {
        return { ok: true, json: async () => ({ data: { connectors: [revoked ? { ...CONNECTOR_ACTIVE, status: 'revoked' } : CONNECTOR_ACTIVE] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    await mount();

    const revokeBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="gc-revoke-gen-1"]')!;
    await act(async () => { revokeBtn.click(); });
    await flush();
    const confirmBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.gcRevokeAction && b !== revokeBtn)!;
    await act(async () => { confirmBtn.click(); });
    await flush();

    expect(revoked).toBe(true);
    expect(document.body.querySelector('[data-status-chip="revoked"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="gc-revoke-gen-1"]')).toBeNull();
  });
});
