// @vitest-environment jsdom
//
// story #2664 — 조직 설정 > 이벤트 관리 화면. BE #2663(GET 목록 id 필드, PR#3069 재QA 중)이
// 아직 develop에 없어 GET 응답에 id가 없는 항목이 실제로 존재한다 — 그 상태에서 수정/비활성
// 버튼이 절대 뜨면 안 된다는 회귀가드가 이 스위트의 핵심(id 없는 걸 PATCH하면 서버가 405/404).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
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

const ORG_ID = 'org-1';

function asAdmin() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }],
    projectMemberships: [],
  });
}

function asMember() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'member' }],
    projectMemberships: [],
  });
}

function preset(overrides: Record<string, unknown> = {}) {
  return {
    key: 'preset.gate.verdict',
    org_id: null,
    payload_schema: { type: 'object', properties: {}, additionalProperties: false },
    routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'work_item_stakeholders' } },
    block_template: null,
    enabled: true,
    version: 2,
    ...overrides,
  };
}

// story #2663 갭 재현 — 목록에 id가 없는 org 커스텀 정의(오늘 등록된 decision/gate_cycle과
// 동형 픽스처).
function customNoId(overrides: Record<string, unknown> = {}) {
  return {
    key: 'org.moonklabs.work.decision',
    org_id: ORG_ID,
    payload_schema: { type: 'object', properties: {}, additionalProperties: false },
    routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
    block_template: null,
    enabled: true,
    version: 1,
    ...overrides,
  };
}

// #2663 머지 이후를 시뮬레이션하는 픽스처(id 있음).
function customWithId(overrides: Record<string, unknown> = {}) {
  return { ...customNoId(), id: 'def-1', ...overrides };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  asAdmin();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function mockFetches(defs: unknown[], opts?: { onPost?: (body: unknown) => { ok: boolean; status?: number; json: () => Promise<unknown> }; onPatch?: (id: string, body: unknown) => { ok: boolean; status?: number; json: () => Promise<unknown> } }) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body });
    if (url === '/api/events/definitions' && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, json: async () => defs };
    }
    if (url === '/api/events/definitions' && init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      return opts?.onPost?.(body) ?? { ok: true, json: async () => ({ ...body, id: 'new-id' }) };
    }
    if (url.startsWith('/api/events/definitions/') && init?.method === 'PATCH') {
      const id = url.split('/').pop()!;
      const body = JSON.parse(init.body ?? '{}');
      return opts?.onPatch?.(id, body) ?? { ok: true, json: async () => ({ ...customWithId(), ...body, id }) };
    }
    if (url === '/api/events/publish' && init?.method === 'POST') {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

async function mount() {
  const { default: OrganizationEventsPage } = await import('./page');
  await act(async () => { root.render(wrap(<OrganizationEventsPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('OrganizationEventsPage', () => {
  it('프리셋·커스텀 그룹을 나눠 렌더하고 관리자에겐 새 정의 버튼이 뜬다', async () => {
    mockFetches([preset(), customWithId()]);
    await mount();
    expect(container.textContent).toContain(koMessages.organization.eventsPresetGroupTitle);
    expect(container.textContent).toContain(koMessages.organization.eventsCustomGroupTitle);
    expect(container.textContent).toContain('preset.gate.verdict');
    expect(container.textContent).toContain('org.moonklabs.work.decision');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventCreateCta)).toBe(true);
  });

  it('일반 멤버는 새 정의 버튼이 없고 읽기전용 안내가 뜬다', async () => {
    asMember();
    mockFetches([preset(), customWithId()]);
    await mount();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventCreateCta)).toBe(false);
    expect(container.textContent).toContain(koMessages.organization.eventReadonlyNotAdmin);
  });

  it('프리셋 항목은 관리자여도 수정/비활성 버튼이 절대 안 뜬다(읽기전용)', async () => {
    mockFetches([preset()]);
    await mount();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventEditCta)).toBe(false);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventDeactivateCta)).toBe(false);
  });

  // story #2663 회귀가드(핵심) — GET 목록에 id가 없는 동안(develop에 아직 안 올라온 상태)
  // 수정/비활성 버튼을 그리면 클릭 시 PATCH 타겟이 없어 깨진다 — id 부재를 관대하게 다루지 않는다.
  it('id 없는 커스텀 정의(#2663 머지 전 상태)는 관리자여도 수정/비활성 버튼이 안 뜬다', async () => {
    mockFetches([customNoId()]);
    await mount();
    expect(container.textContent).toContain('org.moonklabs.work.decision');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventEditCta)).toBe(false);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventDeactivateCta)).toBe(false);
  });

  it('id 있는 커스텀 정의(#2663 머지 후)는 관리자에게 수정/비활성 버튼이 뜬다', async () => {
    mockFetches([customWithId()]);
    await mount();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventEditCta)).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventDeactivateCta)).toBe(true);
  });

  it('비활성 정의는 비활성화 버튼이 안 뜬다(이미 비활성인데 또 끌 이유 없음)', async () => {
    mockFetches([customWithId({ enabled: false })]);
    await mount();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventEditCta)).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.organization.eventDeactivateCta)).toBe(false);
  });

  it('키 항목 클릭 시 payload_schema/routing JSON이 펼쳐진다', async () => {
    mockFetches([preset()]);
    await mount();
    const keyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'preset.gate.verdict')!;
    expect(container.textContent).not.toContain('"work_item_stakeholders"');
    await act(async () => { keyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('"work_item_stakeholders"');
  });

  it('생성 폼 제출 시 org.{slug}. 접두사가 자동으로 붙고 파싱된 JSON을 POST한다', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(keyInput, 'my_event');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const postCall = calls.find((c) => c.method === 'POST' && c.url === '/api/events/definitions');
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body!);
    expect(body.key).toBe('org.moonklabs.my_event');
    expect(body.payload_schema).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
    expect(body.action_auth).toBeNull();
  });

  it('payload_schema에 잘못된 JSON을 넣으면 제출을 막고 에러를 보여준다(POST 미발행)', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    const schemaTextarea = document.body.querySelector('#event-payload-schema') as HTMLTextAreaElement;
    await act(async () => {
      const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      inputSetter.call(keyInput, 'broken');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      taSetter.call(schemaTextarea, '{not valid json');
      schemaTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(document.body.querySelector('[data-slot="dialog-content"]')?.textContent).toContain('JSON');
  });

  it('수정 폼은 key가 읽기전용이고 기존 JSON이 채워진 채로 열리며, 저장 시 PATCH(id 타겟)를 호출한다', async () => {
    const calls = mockFetches([customWithId({ id: 'def-42', key: 'org.moonklabs.my_event' })]);
    await mount();
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventEditCta)!;
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    expect(keyInput.value).toBe('org.moonklabs.my_event');
    expect(keyInput.disabled).toBe(true);

    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventEditSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.url).toBe('/api/events/definitions/def-42');
  });

  it('비활성화 확인 다이얼로그에서 확정하면 PATCH {enabled:false}를 호출한다', async () => {
    const calls = mockFetches([customWithId({ id: 'def-9' })]);
    await mount();
    const deactivateBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventDeactivateCta)!;
    await act(async () => { deactivateBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const confirmBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventDeactivateConfirmCta) as HTMLButtonElement;
    await act(async () => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const patchCall = calls.find((c) => c.method === 'PATCH' && c.url === '/api/events/definitions/def-9');
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall!.body!)).toEqual({ enabled: false });
  });

  it('발행 테스트는 POST /api/events/publish를 definition_key+payload로 호출한다', async () => {
    const calls = mockFetches([customWithId({ id: 'def-7', key: 'org.moonklabs.my_event' })]);
    await mount();
    const testBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventTestPublishCta)!;
    await act(async () => { testBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventTestPublishSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const publishCall = calls.find((c) => c.url === '/api/events/publish');
    expect(publishCall).toBeDefined();
    expect(JSON.parse(publishCall!.body!)).toEqual({ definition_key: 'org.moonklabs.my_event', payload: {} });
  });

  it('비활성 정의는 발행 테스트 버튼이 비활성화된다', async () => {
    mockFetches([customWithId({ id: 'def-1', enabled: false })]);
    await mount();
    const testBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventTestPublishCta) as HTMLButtonElement;
    expect(testBtn.disabled).toBe(true);
  });

  it('BE 거부(400 invalid_definition)를 사람이 읽을 문구로 그대로 보여준다', async () => {
    mockFetches([], {
      onPost: () => ({ ok: false, status: 400, json: async () => ({ error: { message: '네임스페이스가 org.moonklabs.로 시작해야 합니다' } }) }),
    });
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(keyInput, 'x');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain('네임스페이스가 org.moonklabs.로 시작해야 합니다');
  });
});
