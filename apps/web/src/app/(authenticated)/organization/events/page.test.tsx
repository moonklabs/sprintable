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

  // story #2670 — create는 이제 「기본」(3서식 폼) 탭이 기본으로 열린다(AC1). 이 스위트의
  // 기존 JSON-경로 테스트들은 「고급」 탭으로 명시 전환해야 그 시절 동작을 그대로 잰다 —
  // 기본 탭 자체의 새 동작은 이 파일 하단 새 describe에서 별도로 잰다.
  function switchToAdvancedTab() {
    const tabBtn = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((b) => b.textContent?.startsWith(koMessages.organization.definerTabAdvanced)) as HTMLButtonElement;
    tabBtn.click();
  }

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
      properties: { stage: { type: 'string', enum: ['draft', 'done'] } },
      required: ['stage'],
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
      payload_schema: { type: 'object', properties: { stage: { type: 'string', enum: ['draft', 'done'] } }, required: ['stage'], additionalProperties: false },
      routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'payload_field', member_id_field: 'assignee_member_id' } },
    })]);
    await mount();
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.organization.eventEditCta)!;
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 기본 탭이 활성(고급 전용 배지 없음) — #event-key(JSON탭 전용)는 안 보이고 폼 필드가 보인다.
    expect(dialogContent().textContent).not.toContain(koMessages.organization.definerAdvancedOnlyBadge);
    expect(dialogContent().querySelector('#definer-name')).not.toBeNull();
    const stageNameInputs = dialogContent().querySelectorAll('input[placeholder="' + koMessages.organization.definerStageNamePlaceholder + '"]') as NodeListOf<HTMLInputElement>;
    expect([...stageNameInputs].map((i) => i.value)).toEqual(['draft', 'done']);
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
