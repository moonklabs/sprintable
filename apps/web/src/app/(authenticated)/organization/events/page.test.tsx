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

const CURRENT_MEMBER_ID = 'member-me-1';

function asAdmin() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }],
    projectMemberships: [],
    currentTeamMemberId: CURRENT_MEMBER_ID,
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
    // story #2665 — 정의 행을 펼치면 PublishHistorySection이 이 엔드포인트를 호출한다.
    // 응답 계약(PR#3087)은 배열이라 기본값도 배열이어야 한다({}가 아님) — 이 스위트의
    // 다른 대부분 테스트는 이력 자체를 안 재므로 빈 배열(정상 빈 상태)로 안전 폴백.
    if (url.startsWith('/api/events/definitions/publish-history')) {
      return { ok: true, json: async () => [] };
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

// story #2670 — create는 「기본」(3서식 폼) 탭이 기본으로 열린다. 「고급」 탭 경로를 재는
// 스위트들이 공유하는 헬퍼라 모듈 스코프로 둔다(describe 하나에 갇혀 있으면 다른
// describe에서 못 쓴다 — story #2666 작업 중 실제로 겪은 스코프 버그).
function switchToAdvancedTab() {
  const tabBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent?.startsWith(koMessages.organization.definerTabAdvanced)) as HTMLButtonElement;
  tabBtn.click();
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
    await act(async () => { switchToAdvancedTab(); });

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
    await act(async () => { switchToAdvancedTab(); });

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
    await act(async () => { switchToAdvancedTab(); });
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

// story #2670(A층) — 휴먼용 이벤트 정의기(3서식 폼). 판별자: JSON 없이 사이클형 1건을
// 정의→미리보기→저장까지. AC3(폼↔JSON 왕복)는 별도 describe.
describe('OrganizationEventsPage — 이벤트 정의기(story #2670 A층)', () => {
  function dialogContent() {
    return document.body.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  }
  function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('생성 다이얼로그는 「기본」 탭으로 열리고 사이클형이 기본 선택돼 있다(AC1 진입점)', async () => {
    mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(dialogContent().textContent).toContain(koMessages.organization.definerFormat_cycle);
    // 고급 탭 전용 필드(JSON textarea)는 기본 탭에서 안 보인다.
    expect(dialogContent().querySelector('#event-payload-schema')).toBeNull();
    // 미리보기 패널(실 렌더러)이 이미 붙어 있다.
    expect(dialogContent().textContent).toContain(koMessages.organization.definerPreviewLabel);
  });

  it('사이클형 정의 — 이름·키·단계 2개 입력 후 저장하면 파생 JSON을 그대로 POST한다(AC1)', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await act(async () => {
      setInputValue(dialogContent().querySelector('#definer-name') as HTMLInputElement, '릴리즈 흐름');
      setInputValue(dialogContent().querySelector('#definer-key') as HTMLInputElement, 'release_flow');
    });
    const addStageBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.organization.definerAddStage))!;
    await act(async () => { addStageBtn.click(); });
    await act(async () => { addStageBtn.click(); });
    const stageNameInputs = dialogContent().querySelectorAll('input[placeholder="' + koMessages.organization.definerStageNamePlaceholder + '"]');
    expect(stageNameInputs.length).toBe(2);
    await act(async () => {
      setInputValue(stageNameInputs[0] as HTMLInputElement, 'draft');
      setInputValue(stageNameInputs[1] as HTMLInputElement, 'done');
    });

    const submitBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });

    const postCall = calls.find((c) => c.method === 'POST' && c.url === '/api/events/definitions');
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.body!);
    expect(body.key).toBe('org.moonklabs.release_flow');
    expect(body.payload_schema).toEqual({
      type: 'object',
      // routing 기본값(발행할 때 지정)이라 대상 필드가 스키마에도 실린다(PO review_changes
      // 2차 근인 — additionalProperties:false에서 스키마에 없는 필드는 실 발행이 거부됨).
      properties: { stage: { type: 'string', enum: ['draft', 'done'] }, assignee_member_id: { type: 'string' } },
      required: ['stage', 'assignee_member_id'],
      additionalProperties: false,
    });
    expect(body.routing).toEqual({
      escalation: { kind: 'server_derived', target: 'none' },
      broadcast: { kind: 'payload_field', member_id_field: 'assignee_member_id' },
    });
    expect(body.action_auth).toBeNull();
  });

  it('저장 성공 후 다이얼로그가 닫히지 않고 「테스트 발행」이 열린다(§4 한 흐름)', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {
      setInputValue(dialogContent().querySelector('#definer-key') as HTMLInputElement, 'x');
    });
    const addStageBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.organization.definerAddStage))!;
    await act(async () => { addStageBtn.click(); });
    await act(async () => {
      setInputValue(dialogContent().querySelector('input[placeholder="' + koMessages.organization.definerStageNamePlaceholder + '"]') as HTMLInputElement, 'a');
    });
    const submitBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });

    // 다이얼로그 여전히 열려 있음(닫혔으면 dialogContent()가 null) + 테스트 발행 버튼 활성.
    expect(dialogContent()).not.toBeNull();
    const testBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.definerTestPublishCta) as HTMLButtonElement;
    expect(testBtn.disabled).toBe(false);

    await act(async () => { testBtn.click(); });
    const publishCall = calls.find((c) => c.url === '/api/events/publish');
    expect(publishCall).toBeDefined();
    const publishBody = JSON.parse(publishCall!.body!);
    expect(publishBody.definition_key).toBe('org.moonklabs.x');
    // PO 라이브 실측 회귀가드(review_changes) — 기본 routing(발행할 때 지정=payload_field,
    // member_id_field=assignee_member_id)인데 테스트 발행 payload에 그 필드가 없으면 BE가
    // 거부해 "나에게만 보내는 실 발행"(§4) 약속이 깨진다 — 로그인한 나로 자동 충전돼야 한다.
    expect(publishBody.payload.assignee_member_id).toBe(CURRENT_MEMBER_ID);
  });

  it('routing이 「기록만」(server_derived)이면 테스트 발행 payload에 멤버 id를 안 넣는다(과다주입 금지)', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {
      setInputValue(dialogContent().querySelector('#definer-key') as HTMLInputElement, 'y');
    });
    const recordOnlyRadio = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.organization.definerRoutingRecordTitle)) as HTMLButtonElement;
    await act(async () => { recordOnlyRadio.click(); });
    const addStageBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.organization.definerAddStage))!;
    await act(async () => { addStageBtn.click(); });
    await act(async () => {
      setInputValue(dialogContent().querySelector('input[placeholder="' + koMessages.organization.definerStageNamePlaceholder + '"]') as HTMLInputElement, 'a');
    });
    const submitBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    const testBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.definerTestPublishCta) as HTMLButtonElement;
    await act(async () => { testBtn.click(); });

    const publishCall = calls.find((c) => c.url === '/api/events/publish');
    const publishBody = JSON.parse(publishCall!.body!);
    expect(publishBody.payload.assignee_member_id).toBeUndefined();
  });

  it('키가 비었으면 저장 버튼이 비활성이다(fail-closed·서버 400 재생산 방지)', async () => {
    mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const submitBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  // AC3 — JSON→폼 왕복.
  it('폼이 표현 가능한 모양(사이클형)의 기존 정의는 수정 시 「기본」 탭에 복원된 상태로 열린다', async () => {
    mockFetches([customWithId({
      id: 'def-cycle',
      key: 'org.moonklabs.release_flow',
      payload_schema: { type: 'object', properties: { stage: { type: 'string', enum: ['draft', 'done'] }, assignee_member_id: { type: 'string' } }, required: ['stage', 'assignee_member_id'], additionalProperties: false },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'payload_field', member_id_field: 'assignee_member_id' } },
      block_template: { blocks: [{ type: 'header', text: '릴리즈 흐름' }] },
    })]);
    await mount();
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventEditCta)!;
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 기본 탭이 활성(고급 전용 배지 없음) — #event-key(JSON탭 전용)는 안 보이고 폼 필드가 보인다.
    expect(dialogContent().textContent).not.toContain(koMessages.organization.definerAdvancedOnlyBadge);
    // PO review_changes 2차 — 수정 진입 시 이름이 "이름 없음"으로 비던 유실 회귀가드.
    expect((dialogContent().querySelector('#definer-name') as HTMLInputElement).value).toBe('릴리즈 흐름');
    const stageNameInputs = dialogContent().querySelectorAll('input[placeholder="' + koMessages.organization.definerStageNamePlaceholder + '"]') as NodeListOf<HTMLInputElement>;
    expect([...stageNameInputs].map((i) => i.value)).toEqual(['draft', 'done']);
    // assignee_member_id(routing 파생 필드)는 ⑥ 추가 필드 편집 행으로 새어 나오면 안 된다
    // (「이 폼이 파생하는 것」 요약 패널엔 정상적으로 스키마 키로 보이므로 dialog 전체가 아닌
    // 입력 필드 값만 좁혀서 확認).
    const inputValues = [...dialogContent().querySelectorAll('input')].map((i) => (i as HTMLInputElement).value);
    expect(inputValues).not.toContain('assignee_member_id');
  });

  it('폼이 표현 못 하는 모양(routing이 커스텀에서 불가능한 target)의 기존 정의는 「고급 전용」으로 떨어진다(AC3)', async () => {
    mockFetches([customWithId({
      id: 'def-weird',
      key: 'org.moonklabs.weird',
      payload_schema: { type: 'object', properties: { foo: { type: 'string' } }, required: [], additionalProperties: false },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'goal_owner' } },
    })]);
    await mount();
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventEditCta)!;
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(dialogContent().textContent).toContain(koMessages.organization.definerAdvancedOnlyBadge);
    // 고급 탭이 강제로 열려 JSON textarea가 보인다(기존 #3070 편집기 기능 유지 — 손실 0).
    expect(dialogContent().querySelector('#event-payload-schema')).not.toBeNull();
    // 기본 탭 버튼은 비활성(disabled) — 표현 못 하는 정의를 폼으로 잘못 편집하게 두지 않는다.
    const basicTabBtn = [...dialogContent().querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.definerTabBasic) as HTMLButtonElement;
    expect(basicTabBtn.disabled).toBe(true);
  });
});

// story #2665 — PR#3087(디디) BE 계약 소비. 정의 상세(행 펼침)에 최근 발행 이력.
describe('OrganizationEventsPage — 발행 이력(story #2665)', () => {
  it('관리자가 행을 펼치면 definition_key+limit으로 조회하고 발행자·시각·대화 링크가 뜬다(AC1·AC2)', async () => {
    const calls: { url: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url });
      if (url === '/api/events/definitions') return { ok: true, json: async () => [customWithId({ id: 'def-1', key: 'org.moonklabs.my_event' })] };
      if (url.startsWith('/api/events/definitions/publish-history')) {
        return {
          ok: true,
          json: async () => [
            { id: 'pub-1', conversation_id: 'conv-9', sender_id: 'member-1', sender_name: '페드루 올리베이라', created_at: '2026-08-15T12:00:00Z' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    const keyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'org.moonklabs.my_event')!;
    await act(async () => { keyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const historyCall = calls.find((c) => c.url.startsWith('/api/events/definitions/publish-history'));
    expect(historyCall).toBeDefined();
    const url = new URL(historyCall!.url, 'http://x');
    expect(url.searchParams.get('definition_key')).toBe('org.moonklabs.my_event');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(container.textContent).toContain('페드루 올리베이라');
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.organization.eventPublishHistoryOpenChat) as HTMLAnchorElement;
    expect(chatLink.getAttribute('href')).toBe('/chats/conv-9');
  });

  it('이력이 빈 배열이면 빈 상태 문구를 보인다', async () => {
    mockFetches([customWithId({ id: 'def-2', key: 'org.moonklabs.empty_event' })]);
    await mount();
    const keyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'org.moonklabs.empty_event')!;
    await act(async () => { keyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.organization.eventPublishHistoryEmpty);
  });

  it('조회 실패 시 에러 문구를 보이되 카드 자체는 안 죽는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [customWithId({ id: 'def-3', key: 'org.moonklabs.err_event' })] };
      if (url.startsWith('/api/events/definitions/publish-history')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    const keyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'org.moonklabs.err_event')!;
    await act(async () => { keyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.organization.eventPublishHistoryError);
    // 나머지 상세(payload_schema 등)는 여전히 렌더된다 — 이력 실패가 카드 전체를 안 죽인다.
    expect(container.textContent).toContain(koMessages.organization.eventPayloadSchemaLabel);
  });

  it('일반 멤버는 행을 펼쳐도 이력 조회 자체를 안 한다(BE가 admin 전용이라 헛된 403 방지)', async () => {
    asMember();
    const calls = mockFetches([customWithId({ id: 'def-4', key: 'org.moonklabs.member_view' })]);
    await mount();
    const keyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'org.moonklabs.member_view')!;
    await act(async () => { keyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.some((c) => c.url.startsWith('/api/events/definitions/publish-history'))).toBe(false);
  });
});

// story #2666 — 「고급」탭 key 입력이 「기본」탭과 같은 클라 선검증(validateKeySuffix)을
// 받는다. 서버 메시지("...로 시작해야 합니다")가 문자셋 위반을 접두 문제로 오진시키던 것을
// 클라에서 먼저 정확한 원인(문자셋)으로 막는다 — 서버 검증은 그대로 유지(우회 아님).
describe('OrganizationEventsPage — 고급 탭 key 문자셋 클라 선검증(story #2666)', () => {
  it('하이픈 포함 key는 정확한 문자셋 에러를 보이고 클라에서 막혀 서버 오진 메시지에 도달하지 않는다(AC1·AC2·AC3 양성대조)', async () => {
    const calls = mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { switchToAdvancedTab(); });

    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      // story #2666의 원 재현 — screen-check처럼 하이픈이 들어간 key.
      setter.call(keyInput, 'screen-check');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 정확한 원인(문자셋)을 지목한다. 상단 정적 안내("org.{slug}. 로 시작해야 합니다")는
    // 늘 떠 있는 별개 문구라 그 substring으로는 못 가른다 — 대신 실제로 서버까지 요청이
    // 가서 서버의 오진 메시지("org 커스텀 정의의 key는...")를 받는 일 자체가 없는지
    // (클라에서 막혀 POST가 0건인지)로 정확히 잰다.
    expect(document.body.textContent).toContain(koMessages.organization.definerKeyErrorCharset);

    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // 클라에서 막혔으니 방어적으로 클릭해도(disabled 우회 시도) POST가 안 나간다.
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/events/definitions')).toBe(false);
  });

  it('유효한 key(스네이크)로 바꾸면 힌트 문구로 되돌아가고 저장이 다시 가능해진다', async () => {
    mockFetches([]);
    await mount();
    const createBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventCreateCta)!;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { switchToAdvancedTab(); });

    const keyInput = document.body.querySelector('#event-key') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(keyInput, 'bad-key');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).toContain(koMessages.organization.definerKeyErrorCharset);

    await act(async () => {
      setter.call(keyInput, 'good_key');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain(koMessages.organization.definerKeyErrorCharset);
    expect(document.body.textContent).toContain(koMessages.organization.definerKeyHint);
    const submitBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent === koMessages.organization.eventCreateSubmit) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
  });

  it('수정 모드(key 읽기전용)에서는 클라 선검증이 안 뜬다(회귀 0 — 기존 값은 항상 유효)', async () => {
    mockFetches([customWithId({ id: 'def-9', key: 'org.moonklabs.existing-ish' })]);
    await mount();
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventEditCta)!;
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { switchToAdvancedTab(); });
    expect(document.body.textContent).not.toContain(koMessages.organization.definerKeyErrorCharset);
    expect(document.body.textContent).not.toContain(koMessages.organization.definerKeyHint);
  });
});

// story #2677 — 정의 행 펼침 기본 뷰=사람 언어(서식 요약·받는 사람·필드 표·실물 카드),
// JSON은 「고급」 접기. PO review_changes(head cbb0ff0c) — 최초안은 이 전부를
// tryReverseParse(정의기 폼이 만들 수 있는 정확한 모양) 하나에 묶어 프리셋 4종이 전부 JSON
// 그대로였다. fix 후: 필드 표·받는 사람·실물 카드는 raw JSON에서 직접 읽어 역파생 없이
// 항상 뜬다 — 폴백은 «서식(사이클/신호/측정) 분류» 한 줄로만 좁혀진다(AC2).
describe('OrganizationEventsPage — 정의 상세보기 사람 언어 기본(story #2677)', () => {
  function measureCustom(overrides: Record<string, unknown> = {}) {
    return customWithId({
      id: 'def-human-1',
      key: 'org.moonklabs.deploy.completed',
      payload_schema: {
        type: 'object',
        properties: { metric_value: { type: 'number' } },
        required: ['metric_value'],
        additionalProperties: false,
      },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
      action_auth: null,
      block_template: { blocks: [{ type: 'header', text: '배포 완료' }, { type: 'fields', fields: [{ label: '측정치', value: '{{payload.metric_value}}' }] }] },
      ...overrides,
    });
  }

  function expandRow(key: string) {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === key)!;
    return act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  it('서식이 분류되는 정의는 서식/받는 사람/필드 표/실물 카드가 JSON 없이 먼저 보인다', async () => {
    mockFetches([measureCustom()]);
    await mount();
    await expandRow('org.moonklabs.deploy.completed');

    expect(container.textContent).toContain(koMessages.organization.definerFormat_measure);
    // broadcast=server_derived/none은 정의기가 부르는 이름(«기록만») 그대로.
    expect(container.textContent).toContain(koMessages.organization.definerRoutingRecordTitle);
    expect(container.textContent).toContain('metric_value');
    expect(container.textContent).toContain('배포 완료');
  });

  it('JSON 원문은 「고급」 접기 안에 그대로 남아있다(제거 아님, textContent로 확인)', async () => {
    mockFetches([measureCustom()]);
    await mount();
    await expandRow('org.moonklabs.deploy.completed');

    expect(container.textContent).toContain(koMessages.organization.definerTabAdvanced);
    // <details> 닫힌 상태에서도 DOM엔 존재한다(jsdom textContent는 open 여부와 무관) — 제거
    // 여부만 검증하면 충분하다(펼침 UI 자체의 접근성/애니메이션은 이 스토리 범위 밖).
    expect(container.textContent).toContain('"metric_value"');
  });

  it('프리셋(gate.verdict)도 받는 사람·필드 표·JSON 접기가 전부 뜬다(폴백은 서식 한 줄뿐, AC2)', async () => {
    mockFetches([preset()]);
    await mount();
    await expandRow('preset.gate.verdict');

    // properties={}라 3서식(cycle/signal/measure) 어디에도 안 맞아 서식 줄만 미분류 표시.
    expect(container.textContent).toContain(koMessages.organization.eventSummaryFormatUnclassified);
    // 받는 사람(broadcast=work_item_stakeholders)은 역파생과 무관하게 직접 읽혀 사람 언어로 뜬다.
    expect(container.textContent).toContain(koMessages.organization.definerRoutingStakeholdersTitle);
    // JSON은 제거되지 않았다 — 「고급」 접기 안에 여전히 존재.
    expect(container.textContent).toContain('"work_item_stakeholders"');
  });

  it('프리셋(goal.measured)은 metric_value가 있어 서식도 실제로 분류된다(폴백이 필요조차 없는 사례)', async () => {
    mockFetches([preset({
      key: 'preset.goal.measured',
      payload_schema: {
        type: 'object',
        properties: { goal_id: { type: 'string' }, metric_value: { type: 'number' }, metric_unit: { type: 'string' } },
        required: ['goal_id', 'metric_value'],
      },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'goal_owner' } },
    })]);
    await mount();
    await expandRow('preset.goal.measured');

    expect(container.textContent).toContain(koMessages.organization.definerFormat_measure);
    expect(container.textContent).toContain(koMessages.organization.eventRoutingTargetGoalOwner);
    expect(container.textContent).not.toContain(koMessages.organization.eventSummaryFormatUnclassified);
  });

  it('손편집 커스텀(3서식 키와 안 겹치는 스키마)도 받는 사람·필드 표는 직접 렌더된다', async () => {
    mockFetches([customWithId({
      id: 'def-manual-1',
      key: 'org.moonklabs.manual.thing',
      payload_schema: { type: 'object', properties: { foo: { type: 'string' } }, required: [], additionalProperties: false },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'payload_field', member_id_field: 'weird_field_name' } },
    })]);
    await mount();
    await expandRow('org.moonklabs.manual.thing');

    expect(container.textContent).toContain(koMessages.organization.eventSummaryFormatUnclassified);
    expect(container.textContent).toContain(koMessages.organization.definerRoutingAssignTitle);
    expect(container.textContent).toContain('foo');
  });

  it('비활성 정의도 펼침 시 사람 언어 요약이 뜬다(AC3)', async () => {
    mockFetches([measureCustom({ enabled: false })]);
    await mount();
    await expandRow('org.moonklabs.deploy.completed');
    expect(container.textContent).toContain(koMessages.organization.definerFormat_measure);
  });
});

// story #3316 — 카탈로그에 「프로젝트에 적용」 진입점이 없던 갭 + stage_metadata(role/action/
// gate/capability) 상세뷰 부재. cyclicStages()(loop-create-dialog.tsx SSOT) 판별과 동형으로
// payload_schema.properties.stage.enum이 있는 정의만 "적용" 버튼/상세뷰를 얻어야 한다.
describe('OrganizationEventsPage — 카탈로그 적용 진입점 + stage_metadata 상세(story #3316)', () => {
  function cyclicCustom(overrides: Record<string, unknown> = {}) {
    return customWithId({
      id: 'def-cyclic-1',
      key: 'org.moonklabs.recipe.cyclic',
      name: '사이클 레시피',
      payload_schema: {
        type: 'object',
        properties: { stage: { type: 'string', enum: ['draft', 'review'] } },
        required: ['stage'],
        additionalProperties: false,
      },
      stage_metadata: {
        draft: { role: 'Writer', action: '초안 작성' },
        review: {
          role: 'Reviewer', action: '검토',
          gate: { type: 'qa', approver: 'assignee' },
          capability: { kind: 'publish', connector_key: 'slack' },
        },
      },
      ...overrides,
    });
  }

  function expandRow(key: string) {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === key)!;
    return act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  it('사이클형 정의는 펼치면 stage별 role/action과 gate/capability가 사람 언어로 뜬다', async () => {
    mockFetches([cyclicCustom()]);
    await mount();
    await expandRow('org.moonklabs.recipe.cyclic');

    expect(container.textContent).toContain('초안 작성');
    expect(container.textContent).toContain('Writer');
    expect(container.textContent).toContain('검토');
    expect(container.textContent).toContain('Reviewer');
    expect(container.textContent).toContain('qa');
    expect(container.textContent).toContain('publish');
  });

  it('사이클형 정의는 「프로젝트에 적용」 버튼이 뜨고, 클릭하면 적용 다이얼로그가 열린다', async () => {
    mockFetches([cyclicCustom()]);
    await mount();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventApplyCta);
    expect(applyBtn).not.toBeUndefined();
    await act(async () => { applyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain(
      koMessages.organization.eventApplyDialogTitle.replace('{name}', '사이클 레시피'),
    );
  });

  it('신호/측정형(stage.enum 없음) 정의는 「프로젝트에 적용」 버튼이 안 뜬다(AC — 적용할 stage가 없음)', async () => {
    // measureCustom()은 story #2677 describe 블록 로컬 스코프라(switchToAdvancedTab이 남긴
    // 실사고 메모 그대로 재발 방지 — 모듈 스코프가 아니면 딴 describe에서 못 씀) 여기선
    // customWithId()에 stage.enum 없는 payload_schema를 직접 얹어 동형 픽스처를 만든다.
    mockFetches([customWithId({
      id: 'def-measure-1', key: 'org.moonklabs.measure.thing', name: '측정형',
      payload_schema: { type: 'object', properties: { metric_value: { type: 'number' } }, required: ['metric_value'], additionalProperties: false },
      stage_metadata: {},
    })]);
    await mount();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventApplyCta);
    expect(applyBtn).toBeUndefined();
  });

  it('프리셋(org_id=null)도 사이클형이면 「프로젝트에 적용」이 뜬다(읽기전용은 정의 수정만 막지, 적용은 별개)', async () => {
    mockFetches([cyclicCustom({ org_id: null, key: 'preset.recipe.cyclic', name: '프리셋 사이클 레시피' })]);
    await mount();

    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventApplyCta);
    expect(applyBtn).not.toBeUndefined();
  });
});
