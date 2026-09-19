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
});
