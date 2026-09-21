// @vitest-environment jsdom
//
// story #4049(E-RECIPE-1 ①) — /organization/events 마케팅 탭 배선 계약 핀 고정(AC1·AC2):
// 마케팅 레시피 탭에 카드가 뜨고, 적용→크리에이터 슬롯 배정→제출→상세 뷰 도달까지 한
// 흐름으로 이어진다. 「개발 워크플로」 탭(기존 CRUD)은 page.test.tsx가 이미 41개로
// 커버하므로 여기선 손 안 댄다(AC3 — 회귀 0 축은 그 스위트가 지킨다).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #4118 — page.tsx는 <ToastProvider> 밖에서 mount되므로 useToast()가 테스트 환경
// 로컬 useState 폴백으로 빠져(toast.tsx 자체 설계) 어디에도 안 그려진다 — DOM에서 토스트
// 문구를 못 읽는다. addToast 호출 자체를 가로채 검증한다(useDashboardContextMock과 동형
// 관례, importOriginal로 ToastProvider/ToastContainer 등 다른 export는 그대로 보존).
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return { ...actual, useToast: () => ({ addToast: addToastMock, dismissToast: vi.fn(), toasts: [] }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({
    orgId: 'org-1',
    orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }],
    projectMemberships: [],
    currentTeamMemberId: 'member-me-1',
  });
  addToastMock.mockClear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// #4039/#4419 실 seed 축소판(recipe-role-slots.test.ts와 동일 role/gate 축, 0381_preset_
// marketing_video_production_recipe.py 실측) — id 있는 마케팅 프리셋 1건.
// story #4426 P1(카디르 실 시드 E2E 재현, 2026-09-19) — 이전엔 role 값이 한글 표시라벨
// ("크리에이터" 등)이었다 — 실 seed는 영어 role 키("Creator" 등)를 쓴다. 이 드리프트가
// MARKETING_CREATOR_ROLE_KEY의 실 seed 불일치(크리에이터 배정 항상 no-op)를 이 스위트
// 에서도 숨기고 있었다([합성표본=구조숨김]) — 실 값으로 교정.
const MARKETING_RECIPE = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: '소재 확정부터 발행까지.',
  payload_schema: { properties: { stage: { enum: ['draft', 'concept_confirmed', 'published'] } } },
  routing: {}, block_template: null,
  stage_metadata: {
    draft: { role: 'Creator' },
    concept_confirmed: { role: 'Director', gate: { type: 'concept_approval', approver: 'org_owner' } },
    published: { role: 'Publisher' },
  },
  enabled: true, version: 1,
};

function mockFetches() {
  const applyBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
    if (url.startsWith('/api/team-members')) {
      return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
    }
    if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
      applyBodies.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ ok: true, bindings_upserted: 1, warnings: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  return applyBodies;
}

async function mount() {
  const { default: OrganizationEventsPage } = await import('./page');
  await act(async () => { root.render(wrap(<OrganizationEventsPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function switchToMarketingTab() {
  const tab = [...document.body.querySelectorAll('[role="tab"], button')].find((el) => el.textContent?.startsWith('마케팅 워크플로우'));
  await act(async () => { (tab as HTMLElement).click(); });
  await flush();
}

describe('/organization/events — 마케팅 탭(AC1·AC2)', () => {
  it('마케팅 탭에 seed 레시피 카드가 뜬다(개발 워크플로 탭과 별개)', async () => {
    mockFetches();
    await mount();
    await switchToMarketingTab();
    expect(document.body.textContent).toContain('영상 제작 (릴스·쇼츠)');
  });

  it('카드 「적용」 → 4슬롯 다이얼로그 → 크리에이터 제출 → 상세 뷰 도달(AC2 전체 흐름)', async () => {
    const applyBodies = mockFetches();
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    // 4슬롯 다이얼로그가 열렸는지 — 계약 문구로 확認.
    expect(document.body.textContent).toContain('네 슬롯은 각자 제 메커니즘에 꽂혀요');

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => {
      creatorSelect.value = 'agent-1';
      creatorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 제출 바디 — 크리에이터 stage(draft)만 실린다(디렉터·발행자 stage는 role_mapping 밖).
    expect(applyBodies).toEqual([{ project_id: 'proj-1', role_mapping: { draft: 'agent-1' } }]);

    // 적용 성공 → 상세 뷰로 이어짐(9단계 스텝퍼 존재로 판별).
    expect(document.body.querySelector('[data-testid="recipe-stepper"]')).not.toBeNull();
    expect(document.body.textContent).toContain('영상 제작 (릴스·쇼츠)');
  });

  // story #4426 P1 잔여(카디르 재QA, 2026-09-19) — 서버가 result.ok=true·bindings_upserted:0을
  // 반환하면(성공했지만 실은 아무것도 안 바뀐 no-op) 이전엔 page.tsx가 result.ok만 보고
  // 성공 토스트+상세이동을 같이 태워서, 다이얼로그의 no-op 에러와 페이지의 "성공" 내비가
  // 한 화면에 공존했다([두문장 다른세계]) — 이 케이스에서 상세 뷰로 안 넘어가는지 pin.
  it('bindings_upserted:0(성공 응답이지만 no-op)이면 상세 뷰로 안 넘어간다(거짓성공표시 잔여 회귀)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, bindings_upserted: 0, warnings: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 상세 뷰(9단계 스텝퍼)로 안 넘어간다 — 다이얼로그가 열린 채 no-op 에러를 보여준다.
    expect(document.body.querySelector('[data-testid="recipe-stepper"]')).toBeNull();
    expect(document.body.textContent).toContain('저장된 배정이 없어요');
  });

  it('상세 뷰가 stage 원시 slug 대신 표시 라벨을 렌더한다(PO 추가 AC, 2026-09-18)', async () => {
    mockFetches();
    await mount();
    await switchToMarketingTab();

    const detailBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '상세 보기');
    await act(async () => { detailBtn!.click(); });
    await flush();

    const stepper = document.body.querySelector('[data-testid="recipe-stepper"]')!;
    expect(stepper.textContent).toContain('초안');
    expect(stepper.textContent).toContain('컨셉 확정');
    expect(stepper.textContent).toContain('발행');
    expect(stepper.textContent).not.toContain('concept_confirmed');
  });

  // story #4107 — apply 응답에 warnings가 있으면(적용은 성공, bindings_upserted>0) 상세
  // 뷰로 안 넘어간다 — bindings_upserted:0 케이스와 같은 이유([두문장 다른세계] 방지):
  // 다이얼로그가 경고를 보여주는 동안 페이지가 "성공" 상세뷰를 동시에 띄우면 안 된다.
  it('apply 응답에 warnings가 있으면(적용 성공이어도) 상세 뷰로 안 넘어가고 경고가 다이얼로그에 남는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            ok: true, bindings_upserted: 1,
            warnings: ["stage='published': connector_key='x' 커넥터가 아직 등록돼 있지 않아요 — 조직 설정에서 채널을 먼저 연결하세요"],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 상세 뷰(9단계 스텝퍼)로 안 넘어간다 — 다이얼로그가 열린 채 경고 목록을 보여준다.
    expect(document.body.querySelector('[data-testid="recipe-stepper"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="marketing-apply-warnings"]')).not.toBeNull();
    expect(document.body.textContent).toContain('커넥터가 아직 등록돼 있지 않아요');
  });

  // story #4107 CHANGES(페드루 PO 리뷰, 2026-09-21) — 경고를 보여줄 때 성공 처리(토스트+
  // 상세 뷰)를 버리는 게 아니라 다이얼로그가 닫힐 때(「확認」 클릭)까지 미룬다 — 저장은
  // 이미 됐는데 화면은 끝까지 «실패처럼» 보이던 CHANGES 지적의 정공법.
  it('경고 확認 후(「확인」 클릭) 다이얼로그가 닫히고 그제서야 상세 뷰로 이어간다(보류된 성공 처리)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            ok: true, bindings_upserted: 1,
            warnings: ["stage='published': connector_key='x' 커넥터가 아직 등록돼 있지 않아요"],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 경고 확認 전 — 아직 상세 뷰로 안 넘어감(위 테스트와 동일 전제).
    expect(document.body.querySelector('[data-testid="recipe-stepper"]')).toBeNull();

    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="marketing-apply-warnings-confirm"]')!;
    await act(async () => { confirmBtn.click(); });
    await flush();

    // 「확認」 클릭 후 — 다이얼로그는 닫히고(경고 목록 사라짐), 보류됐던 성공 처리가 이제
    // 이어져 상세 뷰(9단계 스텝퍼)로 넘어간다.
    expect(document.body.querySelector('[data-testid="marketing-apply-warnings"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="recipe-stepper"]')).not.toBeNull();
    expect(document.body.textContent).toContain('영상 제작 (릴스·쇼츠)');
  });

  // story #4118(라이브 실사고 그라운딩, 2026-09-21) — 토스트 count가 리터럴 1로 고정돼
  // 있었다(서버가 bindings_upserted:5를 줘도 화면은 «배정 1건»). warnings 없는 즉시-성공
  // 경로(위 AC2 흐름 테스트와 동형 상호작용, count만 5로 교체).
  it('경고 없는 즉시-성공 경로 — 토스트 count가 bindings_upserted(5)를 반영한다(리터럴 1 고정 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, bindings_upserted: 5, warnings: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(addToastMock).toHaveBeenCalledWith({ type: 'success', title: '배정 5건 저장 완료' });
  });

  // story #4118 — 경고 확認 후 이어지는 «보류된» 성공 토스트(onOpenChange 자리, page.tsx
  // 348행)도 같은 결함을 안고 있었다(리터럴 1). 위 "경고 확認 후..." 흐름 테스트와 동형
  // 상호작용 + count(3)만 다르게 해 그 자리를 직접 겨냥한다.
  it('경고 확認 후 보류됐던 성공 토스트도 count가 bindings_upserted(3)를 반영한다(리터럴 1 고정 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [MARKETING_RECIPE] };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '9월 영상 캠페인' }] }) };
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url === `/api/events/definitions/${MARKETING_RECIPE.id}/apply` && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            ok: true, bindings_upserted: 3,
            warnings: ["stage='published': connector_key='x' 커넥터가 아직 등록돼 있지 않아요"],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await mount();
    await switchToMarketingTab();

    const applyBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용');
    await act(async () => { applyBtn!.click(); });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 경고 확認 전엔 성공 토스트가 아직 안 뜬다(보류 — 위 흐름 테스트와 동일 전제).
    expect(addToastMock).not.toHaveBeenCalled();

    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="marketing-apply-warnings-confirm"]')!;
    await act(async () => { confirmBtn.click(); });
    await flush();

    expect(addToastMock).toHaveBeenCalledWith({ type: 'success', title: '배정 3건 저장 완료' });
  });
});
