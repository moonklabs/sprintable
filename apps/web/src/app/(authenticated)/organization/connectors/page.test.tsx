// @vitest-environment jsdom
//
// story 4180f67f — 조직 커넥터 설정 화면. organization/events/page.test.tsx와 동형 harness
// (useDashboardContext 목·NextIntlClientProvider·createRoot). connector_key 하드코딩 없이
// 목록 응답만으로 카드를 그리는지, org_config 저장·시크릿 미노출·미충족 필수 필드 배지를
// 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import OrganizationConnectorsPage from './page';

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

const ORG_ID = 'org-1';

function asAdmin() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }],
    projectMemberships: [],
    currentTeamMemberId: 'member-me-1',
  });
}

function asMember() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'member' }],
    projectMemberships: [],
  });
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
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const STIBEE_CONNECTOR = {
  connector_key: 'stibee', version: '1.0.0', channel: 'stibee', kinds: ['publish'],
  requires_env: ['STIBEE_ACCESS_TOKEN'],
  fields: [
    { name: 'html', source: 'content', type: 'string' },
    { name: 'create.senderEmail', source: 'org_config', type: 'string', required: true },
    { name: 'create.listId', source: 'org_config', type: 'number', required: true },
  ],
  org_config: {},
};

function stubFetch(connectors: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/connectors`) {
        return { ok: true, status: 200, json: async () => ({ data: connectors, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

describe('OrganizationConnectorsPage — 조회(story 4180f67f)', () => {
  it('등록 0건 — «등록된 커넥터 없음» 안내(하드코딩 카드 0)', async () => {
    asAdmin();
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.organization.connectorsEmpty);
  });

  it('⭐목록 응답만으로 카드를 그린다(connector_key 하드코딩 없음 — 임의 키도 뜬다)', async () => {
    asAdmin();
    stubFetch([{ ...STIBEE_CONNECTOR, connector_key: 'a-brand-new-custom-connector', requires_env: [], fields: [] }]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    expect(container.textContent).toContain('a-brand-new-custom-connector');
  });

  it('⭐requires_env는 이름만 뜨고 값 입력 UI가 없다(시크릿 미노출)', async () => {
    asAdmin();
    stubFetch([STIBEE_CONNECTOR]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    expect(container.textContent).toContain('STIBEE_ACCESS_TOKEN');
    // requires_env 자리엔 input이 없다 — org_config 필드(2개)만큼만 input이 있어야 한다.
    expect(container.querySelectorAll('input').length).toBe(2);
  });

  it('⭐필수 org_config 미충족 — 배지 노출(누락 필드명이 배지 자체 안에 포함)', async () => {
    // 필드명은 설정값 목록 행에도 항상 나오므로(배지 유무와 무관) container.textContent 대조는
    // 뮤테이션(배지 로직 자체를 지워도 그린)을 못 잡는다 — 배지 고유 접두(번역 문구의 "{fields}"
    // 앞부분)로 배지 존재 자체를 판별한다.
    asAdmin();
    stubFetch([STIBEE_CONNECTOR]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    const badgePrefix = koMessages.organization.connectorsMissingRequiredBadge.split('{fields}')[0];
    expect(container.textContent).toContain(badgePrefix);
    expect(container.textContent).toContain(`${badgePrefix}create.senderEmail, create.listId`);
  });

  it('필수 org_config 전부 충족 — 미충족 배지 없음(배지 고유 접두 0건)', async () => {
    asAdmin();
    stubFetch([{ ...STIBEE_CONNECTOR, org_config: { 'create.senderEmail': 'a@b.com', 'create.listId': 1 } }]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    const badgePrefix = koMessages.organization.connectorsMissingRequiredBadge.split('{fields}')[0];
    expect(container.textContent).not.toContain(badgePrefix);
  });

  it('non-admin — 저장 버튼·input 없이 읽기전용, 안내 문구 노출', async () => {
    asMember();
    stubFetch([{ ...STIBEE_CONNECTOR, org_config: { 'create.senderEmail': 'a@b.com', 'create.listId': 1 } }]);
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.organization.connectorsReadonlyNotAdmin);
    expect(container.querySelectorAll('input').length).toBe(0);
    expect(container.textContent).toContain('a@b.com');
  });
});

describe('OrganizationConnectorsPage — 저장(story 4180f67f)', () => {
  it('⭐저장 → PUT body가 입력값만(빈 값 제외) 정확히 싣는다', async () => {
    asAdmin();
    let putBody: unknown;
    let putUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/organizations/${ORG_ID}/connectors`) {
          return { ok: true, status: 200, json: async () => ({ data: [STIBEE_CONNECTOR], error: null, meta: null }) };
        }
        if (init?.method === 'PUT') {
          putUrl = url;
          putBody = JSON.parse(String(init.body));
          return {
            ok: true, status: 200,
            json: async () => ({ data: { ...STIBEE_CONNECTOR, org_config: putBody && typeof putBody === 'object' ? (putBody as { config: unknown }).config : {} }, error: null, meta: null }),
          };
        }
        throw new Error('unexpected fetch: ' + url);
      }),
    );
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    // React 18 createRoot 컨트롤드 input — 네이티브 value setter로 우회해야 React의 onChange가
    // 실제로 트리거된다(plain `.value = ...` + dispatchEvent만으론 React가 값 변화를 못 봄).
    function setNativeValue(el: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    await act(async () => {
      setNativeValue(inputs[0], 'hello@example.com');
      setNativeValue(inputs[1], '42');
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.organization.connectorsSaveCta);
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(putUrl).toBe(`/api/organizations/${ORG_ID}/connectors/stibee/config`);
    expect(putBody).toEqual({ config: { 'create.senderEmail': 'hello@example.com', 'create.listId': 42 } });
  });

  it('⭐422(미선언 키·타입불일치) — 백엔드 detail 문구가 화면에 그대로 나온다', async () => {
    asAdmin();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/organizations/${ORG_ID}/connectors`) {
          return { ok: true, status: 200, json: async () => ({ data: [STIBEE_CONNECTOR], error: null, meta: null }) };
        }
        if (init?.method === 'PUT') {
          return { ok: false, status: 422, json: async () => ({ detail: 'unknown config key: bogus' }) };
        }
        throw new Error('unexpected fetch: ' + url);
      }),
    );
    await act(async () => {
      root.render(wrap(<OrganizationConnectorsPage />));
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.organization.connectorsSaveCta);
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('unknown config key: bogus');
  });
});
