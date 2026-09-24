// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ActivationChecklistBanner } from './activation-checklist-banner';
import { _resetActivationStatusCacheForTests } from '@/hooks/use-activation-status';

// story #3201 — useDashboardContext(projectId)·useRouter 신규 의존성. storage-capacity-
// banner.test.tsx와 동일 패턴(실 dashboard-shell.tsx 전체 모듈 그래프를 끌어들이지 않음).
// story #3610(3607 잔여) CHANGES-2(유나 확認·PO 채택 2026-09-07) — orgId 비교를 폐기하고
// BE가 낸 scope_is_requested_org 불리언만 본다(dashboard-shell 의존 0으로 축소). 기존
// 픽스처(PARTIAL·COMPLETE)는 이 필드를 안 실어(undefined) 새 가드(`=== false`만 숨김)가
// 항상 통과해 회귀 0 — 신규 테스트만 명시로 채운다.
// story #4032(CLS 처방 CHANGES-1) — initialActivationComplete는 기본 undefined(기존
// 16건 회귀 없음, 서버가 모르는 것과 동일하게 클라이언트가 알아낸다) — 신규 테스트만
// mutable 참조로 덮어써 "서버가 이미 완주를 안다" 경로를 시뮬레이션한다.
let mockInitialActivationComplete: boolean | undefined;
// story #4219 F1 — 완주 플래그·결과는 org 범위(orgId) · 접힘은 서버도 아는 세션 쿠키(initialActivationCollapsed).
let mockInitialActivationCollapsed: boolean | undefined;
// story #4219 F1(PO 리뷰) — 컨텍스트 org(지금 보는 org)와 레이아웃이 시드를 조회한 org(activationOrgId)를 따로 바꿀 수 있게.
const mockOrg = { orgId: 'org-1', activationOrgId: 'org-1' as string | undefined, seedFromHint: false };
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    projectId: 'proj-1', orgId: mockOrg.orgId, activationOrgId: mockOrg.activationOrgId, activationSeedFromHint: mockOrg.seedFromHint,
    initialActivationComplete: mockInitialActivationComplete, initialActivationCollapsed: mockInitialActivationCollapsed,
  }),
}));
const routerPushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));
const createFirstInstructionConversationMock = vi.fn();
vi.mock('@/lib/onboarding/first-instruction', () => ({
  createFirstInstructionConversation: (...args: unknown[]) => createFirstInstructionConversationMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETE_KEY = 'sprintable_activation_checklist_complete:org-1';

// story #2059(kanban-board.test.tsx)/chat-input.test.tsx와 동일 패턴 — jsdom/Node의 네이티브
// local/sessionStorage가 이 실행 환경에서 온전치 않아(--localstorage-file 미설정 시 .clear()
// 등이 없는 스텁으로 대체됨) Map 기반 페이크로 통째로 교체한다.
let localStore: Map<string, string>;
let sessionStore: Map<string, string>;
function stubStorages() {
  localStore = new Map<string, string>();
  sessionStore = new Map<string, string>();
  const make = (store: Map<string, string>) => ({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('localStorage', make(localStore));
  vi.stubGlobal('sessionStorage', make(sessionStore));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubStorages();
  routerPushMock.mockClear();
  createFirstInstructionConversationMock.mockReset();
  _resetActivationStatusCacheForTests();
  mockInitialActivationComplete = undefined;
  mockInitialActivationCollapsed = undefined;
  mockOrg.orgId = 'org-1'; mockOrg.activationOrgId = 'org-1'; mockOrg.seedFromHint = false;
  document.cookie = 'sp_activation_hint=; Path=/; Max-Age=0';
  document.cookie = 'sp_activation_collapsed=; Path=/; Max-Age=0';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubChecklist(data: {
  steps: Record<string, boolean>;
  completed: number;
  total: number;
  all_complete: boolean;
  first_instruction_conversation_id?: string | null;
  scope_is_requested_org?: boolean;
}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));
}

const PARTIAL = {
  steps: { signed_up: true, email_verified: false, org_created: true, agent_connected: false, first_roundtrip: false },
  completed: 2,
  total: 5,
  all_complete: false,
  first_instruction_conversation_id: null,
};

const COMPLETE = {
  steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: true },
  completed: 5,
  total: 5,
  all_complete: true,
};

describe('ActivationChecklistBanner — 미완주 렌더 (story #3159)', () => {
  it('미완주면 진행률·단계 목록이 한국어로 렌더된다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
    expect(container.textContent).toContain('2/5단계 완료');
    expect(container.textContent).toContain('이메일 인증하기');
  });
});

// story #4032(Lighthouse CI 실측 — 인증화면 6곳 전부 CLS>0.1, 공통 뿌리가 이 배너였다) —
// fetch 완료 前 null을 그대로 반환하면 부모의 `empty:hidden` 래퍼가 0높이로 접혔다가
// 실 콘텐츠가 도착하는 순간 나타나며 그 아래 전체(모든 페이지 공통 그리드)를 밀어낸다.
// 처방(스켈레톤으로 자리 선점)이 실제로 "fetch 미완료 순간에도 박스가 이미 있다"를
// 만드는지, 그리고 그 박스가 실 콘텐츠와 같은 행 수(5)를 갖는지를 이 두 테스트가 고정한다.
// story #4027 선례와 동일 패턴 — 자동응답 스텁은 이 컴포넌트의 fetch 체인이 같은
// act() 사이클 안에서 이미 resolve돼(실측: 자동응답으로는 "flush 前" 순간을 못 잡음)
// 로딩 상태를 관측할 수 없었다. 응답을 수동으로 붙잡아 두는 deferred promise로
// "아직 안 왔다"를 실제로 만든다. 모듈 스코프로 둬 다른 describe도 재사용한다.
function deferredChecklistResponse() {
  let resolve!: (data: typeof PARTIAL) => void;
  const promise = new Promise<typeof PARTIAL>((res) => { resolve = res; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: await promise }) })));
  return { resolve };
}

describe('ActivationChecklistBanner — 로딩 스켈레톤이 자리를 선점한다 (story #4032, CLS 처방)', () => {
  it('fetch 완료 前에는 실 텍스트 0인 채로 aria-busy 박스를 먼저 그린다(마운트 즉시, flush 前)', async () => {
    const { resolve } = deferredChecklistResponse();
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    const busyEl = container.querySelector('[aria-busy="true"]');
    expect(busyEl).not.toBeNull();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
    await act(async () => { resolve(PARTIAL); });
    await flush();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
  });

  it('스켈레톤 박스는 실 배너와 동일한 5행을 갖는다(행 수가 갈리면 실 콘텐츠 교체 시 다시 흔들린다)', async () => {
    const { resolve } = deferredChecklistResponse();
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    expect(container.querySelectorAll('li').length).toBe(5);
    await act(async () => { resolve(PARTIAL); });
    await flush();
    expect(container.querySelectorAll('li').length).toBe(5);
  });

  it('서버도 완주 여부를 모르면(initialActivationComplete=undefined) fetch 도착 前까지는 스켈레톤이 뜬다(잔여 갭 — 아래 서버-known 테스트가 이 갭을 좁히는 정상 경로)', async () => {
    stubChecklist(COMPLETE);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    // story #4032 CHANGES-1(PO 지적) — 이전엔 이 테스트가 "정상 설계"라고 적었으나, 이
    // 시나리오(로컬스토리지도 서버신호도 둘 다 없음)가 바로 「완주했지만 이 기기는
    // 모른다」는 실사용자 경로였다 — fetch 도착 前 스켈레톤이 떴다가 도착 즉시 접히는
    // 것 자체가 새로 만든 흔들림이었다. 아래 테스트(initialActivationComplete=true)가
    // 실사용에서 이 경로를 실제로 대체한다((authenticated)/layout.tsx가 서버에서 이미
    // 조회해 둔 값을 넘긴다) — 이 테스트는 그 서버신호 자체가 없는(SSR 조회 실패 등)
    // 좁은 잔여 케이스만 고정한다.
    await flush();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
  });
});

// story #4032 CHANGES-1(PO 지적) — "완주했지만 이 브라우저는 모른다"(새 기기·시크릿 창·
// 저장소 삭제) 사용자가 스켈레톤 노출→접힘의 새 흔들림을 겪지 않으려면, 서버가 이미
// 아는 값((authenticated)/layout.tsx가 org 컨텍스트 확定 뒤 조회)을 첫 렌더부터 신뢰해야
// 한다 — 이 값이 있으면 로컬스토리지 유무와 무관하게 클라이언트 fetch 자체를 스킵한다.
describe('ActivationChecklistBanner — 서버가 이미 아는 완주 신호(story #4032 CHANGES-1)', () => {
  it('initialActivationComplete=true면 localStorage 플래그가 없어도(새 기기 시뮬레이션) fetch 자체를 스킵하고 스켈레톤 없이 바로 미노출이다', async () => {
    mockInitialActivationComplete = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(window.localStorage.getItem(COMPLETE_KEY)).toBeNull(); // 새 기기 전제 확認
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull(); // 스켈레톤 자체가 없음
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled(); // 클라이언트 fetch 자체가 안 나감
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
  });

  it('initialActivationComplete=false면 서버가 "아직 아님"을 확認해 준 것이므로 fetch로 실 진행률을 마저 받아온다(스켈레톤 경로는 그대로 유지)', async () => {
    mockInitialActivationComplete = false;
    const { resolve } = deferredChecklistResponse();
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => { resolve(PARTIAL); });
    await flush();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
  });
});

describe('ActivationChecklistBanner — 완주 시 완전 소멸 (PO 지시)', () => {
  it('all_complete=true면 아무것도 렌더하지 않고 localStorage에 영구 기록한다', async () => {
    stubChecklist(COMPLETE);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
    expect(window.localStorage.getItem(COMPLETE_KEY)).toBe('1');
  });

  it('localStorage에 완주 플래그가 있으면 fetch 자체를 건너뛴다', async () => {
    window.localStorage.setItem(COMPLETE_KEY, '1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
  });
});

describe('ActivationChecklistBanner — 접기(collapse), 완전 dismiss는 없음 (PO 정정)', () => {
  it('접기를 누르면 체크리스트는 숨고 진행률 칩은 남는다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('이메일 인증하기');

    const collapseBtn = container.querySelector('button[aria-label="접기"]') as HTMLButtonElement;
    expect(collapseBtn).not.toBeNull();
    await act(async () => { collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('이메일 인증하기');
    expect(container.textContent).toContain('가입 완료 2/5');
    expect(document.cookie).toContain('sp_activation_collapsed=org-1');
  });

  it('접힌 칩을 다시 누르면 펼쳐진다', async () => {
    mockInitialActivationCollapsed = true;
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입 완료 2/5');
    expect(container.textContent).not.toContain('이메일 인증하기');

    const chip = container.querySelector('button[aria-label="펼치기"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain('이메일 인증하기');
  });
});

describe('ActivationChecklistBanner — scope_is_requested_org 불일치 시 미노출(story #3610, 3607 잔여·CHANGES-2)', () => {
  it('scope_is_requested_org===true면 그대로 렌더된다(오탐 0)', async () => {
    stubChecklist({ ...PARTIAL, scope_is_requested_org: true });
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
  });

  it('scope_is_requested_org===false면 아무것도 렌더하지 않는다(요청 org와 판정 org가 갈리는 switch-org 전환 창 포함 — orgId 프레임 불일치 원인과 무관하게 BE 판단만 본다)', async () => {
    stubChecklist({ ...PARTIAL, scope_is_requested_org: false });
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
  });

  it('scope_is_requested_org가 undefined(구 응답 shape)면 기존처럼 렌더 유지(과다 은닉 방지)', async () => {
    stubChecklist({ ...PARTIAL });
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
  });
});

describe('ActivationChecklistBanner — 조회 실패 시 미노출', () => {
  it('fetch 실패하면 아무것도 렌더하지 않는다(에러 표면 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    // 스켈레톤 줄 상자용 폭 0 글자(​ · story #4219)는 보이는 글자가 아니다.
    expect(container.textContent!.replace(/\u200b/g, '')).toBe('');
  });
});

// story #3201(AC2) — "첫 지시…" 항목만 클릭 가능(해당 대화로 이동).
describe('ActivationChecklistBanner — "첫 지시…" 항목 클릭(story #3201)', () => {
  it('first_instruction_conversation_id가 있으면 신규 생성 없이 바로 그 대화로 이동한다', async () => {
    stubChecklist({ ...PARTIAL, first_instruction_conversation_id: 'conv-abc' });
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const target = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('첫 지시 보내고 회신 받기'),
    ) as HTMLButtonElement;
    expect(target).not.toBeUndefined();
    await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createFirstInstructionConversationMock).not.toHaveBeenCalled();
    expect(routerPushMock).toHaveBeenCalledWith('/chats/conv-abc?p=proj-1') /* story #4231 — 현재 프로젝트를 싣는다 */;
  });

  it('first_instruction_conversation_id가 null이면 신규 DM 생성 경로(connect-step과 동일)를 타 그 대화로 이동한다', async () => {
    stubChecklist({ ...PARTIAL, first_instruction_conversation_id: null });
    createFirstInstructionConversationMock.mockResolvedValue('conv-new');
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const target = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('첫 지시 보내고 회신 받기'),
    ) as HTMLButtonElement;
    await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createFirstInstructionConversationMock).toHaveBeenCalledWith('proj-1');
    expect(routerPushMock).toHaveBeenCalledWith('/chats/conv-new?p=proj-1') /* story #4231 — 현재 프로젝트를 싣는다 */;
  });

  it('다른 항목(예: 이메일 인증하기)은 여전히 클릭 불가능한 li다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const emailItem = Array.from(container.querySelectorAll('li')).find(
      (li) => li.textContent?.includes('이메일 인증하기'),
    );
    expect(emailItem?.querySelector('button')).toBeNull();
  });

  // story #3638(유나 §8 별건) — 대화 생성이 null을 반환하면(실패) 스피너만 멈추고
  // 조용했다(클릭했는데 아무 일도 없었던 것처럼 보임). connect-step.tsx의 같은 호출은
  // null을 "건너뛰고 진행"으로 의도적으로 쓰므로(온보딩 흐름이 이 클릭 하나로 안
  // 막혀야 함) 그쪽은 그대로 두고, 이 배너는 클릭 자체가 유일한 목적이라 실패를 알린다.
  it('신규 DM 생성이 실패(null)하면 firstInstructionStartFailed 문구가 뜬다(구 침묵)', async () => {
    stubChecklist({ ...PARTIAL, first_instruction_conversation_id: null });
    createFirstInstructionConversationMock.mockResolvedValue(null);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const target = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('첫 지시 보내고 회신 받기'),
    ) as HTMLButtonElement;
    await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(routerPushMock).not.toHaveBeenCalledWith(expect.stringContaining('/chats/'));
    expect(container.textContent).toContain('대화를 시작하지 못했어요. 다시 시도해 주세요.');
  });
});

// story #3907(PO 눈 리뷰, 3901 캡처 그라운딩) — 5번째("첫 지시…") Button만 min-h-11(size
// variant 기본)·border를 형제(4번째 Link)와 다르게 얹어 실측(getBoundingClientRect)
// iconX 42→43(+1px)·liHeight 24→44(+20px)로 밀려 보였다. min-h-0·border-0로 명시
// 상쇄한 것을 회귀가드로 고정 — 지우면(size variant 기본값 그대로 새는 자리로 돌아가면)
// 이 테스트가 잡는다.
describe('ActivationChecklistBanner — 5번째 항목 아이콘 들여쓰기/행 높이 정합(story #3907)', () => {
  it('"첫 지시…" Button이 4번째 Link와 같은 박스모델 클래스(min-h-0·border-0·h-auto·min-w-0)를 갖는다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const firstRoundtripBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('첫 지시 보내고 회신 받기'),
    ) as HTMLButtonElement;
    expect(firstRoundtripBtn).not.toBeUndefined();

    for (const cls of ['h-auto', 'min-h-0', 'w-full', 'min-w-0', 'border-0', 'gap-1.5', 'px-1', 'py-0.5']) {
      expect(firstRoundtripBtn.className).toContain(cls);
    }
  });

  it('4번째(에이전트 연결하기) Link와 5번째(첫 지시…) Button의 행 폭·패딩 클래스가 동일 집합이다(구조 드리프트 회귀가드)', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();

    const agentLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.textContent?.includes('에이전트 연결하기'),
    ) as HTMLAnchorElement;
    const roundtripBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('첫 지시 보내고 회신 받기'),
    ) as HTMLButtonElement;

    const SHARED_BOX_CLASSES = ['h-auto', 'w-full', 'min-w-0', 'gap-1.5', 'rounded', 'px-1', 'py-0.5'];
    for (const cls of SHARED_BOX_CLASSES) {
      expect(agentLink.className.split(' ')).toContain(cls);
      expect(roundtripBtn.className.split(' ')).toContain(cls);
    }
  });
});

describe('ActivationChecklistBanner — 자리 표시 크기 = 배너 상태(story #4219 F1 CLS)', () => {
  it('⭐접어 둔 사용자(세션 쿠키) → 조회 중 자리 표시가 접힌 칩과 같은 박스 · 결과 뒤 접힌 칩', async () => {
    mockInitialActivationCollapsed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return { ok: true, json: async () => ({ data: PARTIAL }) }; }));
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    const skeleton = container.querySelector('[data-testid="activation-skeleton-collapsed"]');
    expect(skeleton).toBeTruthy();
    expect(container.querySelector('[data-testid="activation-skeleton-expanded"]')).toBeNull();
    const boxOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).sort().join(' ');
    const skeletonBox = boxOf(skeleton);
    release();
    await flush();
    const chip = container.querySelector('button[aria-expanded="false"]');
    expect(chip).toBeTruthy();
    expect(boxOf(chip)).toBe(skeletonBox);
  });

  it('펼친 사용자 → 조회 중 자리 표시는 펼친 배너 스켈레톤(기존 #4032)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return { ok: true, json: async () => ({ data: PARTIAL }) }; }));
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    expect(container.querySelector('[data-testid="activation-skeleton-expanded"]')).toBeTruthy();
    // ⭐<p>(AlertTitle·AlertDescription) 안에 <div> 스켈레톤이 있으면 서버 HTML을 파서가 쪼개 줄 상자가 실 배너와 달라진다
    // (로컬 실측 226 vs 221.5px → 수정 뒤 221.5 = 221.5 · 접힘 30 = 30).
    const sk = container.querySelector('[data-testid="activation-skeleton-expanded"]')!;
    expect(sk.querySelectorAll('p div').length).toBe(0);
    expect(sk.querySelector('[data-testid="activation-skeleton-title"]')).toBeTruthy();
    expect(sk.querySelector('[data-testid="activation-skeleton-desc"]')).toBeTruthy();
    release();
    await flush();
  });

  it('힌트 기록은 결과가 판정된 org로(현재 컨텍스트 org 아님) — 소스 핀', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'activation-checklist-banner.tsx'), 'utf8');
    expect(src).toMatch(/writeActivationHint\(stateOrgId, state\.all_complete\)/);
    expect(src).toMatch(/writeActivationHint\(activationOrgId, true\)/);
    expect(src).not.toMatch(/writeActivationHint\(orgId,/);
  });
});

describe('ActivationChecklistBanner — org 범위 판정 하나로 네 곳(story #4219 F1 PO 리뷰)', () => {
  const hintCookie = () => document.cookie.split('; ').find((c) => c.startsWith('sp_activation_hint='))?.split('=')[1];

  it('⭐A 서버 시드(완주·접힘)가 있는 채로 B로 전환 → B 배너 정상(A 완주로 안 숨음 · A 접힘 안 물려받음) · 힌트·완주 플래그는 B 결과로만', async () => {
    // A 문서: 서버가 A를 «완주»·«접힘»으로 조회해 둔 상태. 컨텍스트는 이미 B(flat 경로·전환 창).
    mockOrg.orgId = 'org-b';
    mockOrg.activationOrgId = 'org-a';
    mockInitialActivationComplete = true;
    mockInitialActivationCollapsed = true;
    window.localStorage.setItem('sprintable_activation_checklist_complete:org-a', '1');
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ data: PARTIAL }) }));
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    // ① 서버 시드(A 완주)가 B를 숨기지 않고 B를 조회했다.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ② A 접힘을 물려받지 않고 펼친 배너.
    expect(container.querySelector('[data-testid="activation-banner"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activation-chip"]')).toBeNull();
    // ③ 힌트는 B 결과로만(A 시드를 B로도 A로도 새로 쓰지 않음).
    expect(decodeURIComponent(hintCookie() ?? '')).toBe('org-b:incomplete');
    // ④ 완주 플래그: B 결과(미완주)로 B 키만 · A 키는 그대로(A 값 0 영향).
    expect(window.localStorage.getItem('sprintable_activation_checklist_complete:org-b')).toBeNull();
    expect(window.localStorage.getItem('sprintable_activation_checklist_complete:org-a')).toBe('1');
  });

  it('다른 org 판정 결과(scope_is_requested_org === false)는 힌트·완주 플래그 둘 다 안 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ...PARTIAL, all_complete: true, completed: 5, scope_is_requested_org: false } }) })));
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(hintCookie()).toBeUndefined();
    expect(window.localStorage.getItem('sprintable_activation_checklist_complete:org-1')).toBeNull();
  });
});
