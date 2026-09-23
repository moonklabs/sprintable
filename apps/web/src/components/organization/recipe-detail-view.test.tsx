// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 상세 뷰 계약 핀 고정: 9단계 스텝퍼가 payload_schema.stage.enum
// 순서 그대로 뜨고, 게이트는 그 stage 자리에서만 마커가 서며, live/building 구분은
// gate-type-label.ts 레지스트리(story #3565 정본)로 실제 판별한다 — 문자열을 하드코딩하지
// 않는다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { RecipeDetailView } from './recipe-detail-view';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import koMessages from '../../../messages/ko.json';

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// #4039 seed 축소판 — 9 stage·게이트 2(concept_approval=레지스트리 등재="live"·
// made_up_future_gate=미등재="building" — #4044가 아직 안 지은 ⓑ구조/ⓒ예산과 동형 상황).
const RECIPE: EventDefinitionResponse = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: null,
  payload_schema: {
    properties: {
      stage: {
        enum: ['draft', 'concept_confirmed', 'animatic', 'structure_passed', 'live_generation',
          'verification', 'editing', 'pending_approval', 'published'],
      },
    },
  },
  stage_metadata: {
    draft: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
    animatic: { role: '크리에이터' },
    structure_passed: { role: '디렉터', gate: { type: 'made_up_future_gate', approver: 'org_owner' } },
    live_generation: { role: '디렉터', capability: { kind: 'generate' } },
    verification: { role: '크리에이터' },
    editing: { role: '크리에이터' },
    pending_approval: { role: '발행자', gate: { type: 'external_publish', approver: 'org_owner' } },
    published: { role: '발행자', capability: { kind: 'publish' } },
  },
  enabled: true,
};

describe('RecipeDetailView — 9단계 스텝퍼·게이트 4(live/building 실판별)', () => {
  it('9단계가 payload_schema.stage.enum 순서로 전부 뜨고, 요약에 단계/게이트/역할 수가 맞는다', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const stepper = container.querySelector('[data-testid="recipe-stepper"]')!;
    // story #4049(PO 추가 AC, 유나 정본 라벨) — stage는 이제 원시 slug가 아니라 표시
    // 라벨로 렌더된다(recipe-stage-label.ts).
    expect(stepper.textContent).toContain('초안');
    expect(stepper.textContent).toContain('발행');
    expect(stepper.textContent).not.toContain('draft');
    // 요약: 단계 9 · 게이트 3(concept_confirmed·structure_passed·pending_approval) · 역할 3.
    expect(container.textContent).toMatch(/단계\s*9/);
    expect(container.textContent).toMatch(/게이트\s*3/);
    expect(container.textContent).toMatch(/역할\s*3/);
  });

  it('게이트 마커는 게이트 있는 stage에서만 선다(3곳)', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    expect(container.querySelector('[data-testid="gate-marker-concept_confirmed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gate-marker-structure_passed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gate-marker-pending_approval"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gate-marker-draft"]')).toBeNull();
    expect(container.querySelector('[data-testid="gate-marker-live_generation"]')).toBeNull();
  });

  it('게이트 카드의 승인자가 raw 키 대신 사람 낱말로 렌더된다(story #4087 AC1)', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const detail = container.querySelector('[data-testid="recipe-gate-detail"]')!;
    expect(detail.textContent).toContain(koMessages.organization.recipeGateApproverOrgOwner);
    expect(detail.textContent).not.toContain('org_owner');
  });

  it('미등재 approver 키는 게이트 카드에서도 raw 값 대신 중립 문구로 렌더된다(story #4087 AC2)', async () => {
    const recipeWithUnknownApprover: EventDefinitionResponse = {
      ...RECIPE,
      stage_metadata: {
        ...RECIPE.stage_metadata,
        pending_approval: { role: '발행자', gate: { type: 'external_publish', approver: 'some_future_unmapped_key' } },
      },
    };
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={recipeWithUnknownApprover} />)); });
    const detail = container.querySelector('[data-testid="recipe-gate-detail"]')!;
    expect(detail.textContent).toContain(koMessages.organization.recipeGateApproverUnknown);
    expect(detail.textContent).not.toContain('some_future_unmapped_key');
  });

  it('gate-type-label 레지스트리에 있는 gate_type만 "강제"(live) 배지, 미등재는 "이 카드가 지음"(building)', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const cards = [...container.querySelectorAll('[data-testid="recipe-gate-detail"] > *')];
    expect(cards).toHaveLength(3);
    const liveCards = cards.filter((c) => c.textContent?.includes('강제'));
    const buildingCards = cards.filter((c) => c.textContent?.includes('이 카드가 지음'));
    // concept_approval·external_publish = 레지스트리 등재(live) · made_up_future_gate = 미등재(building).
    expect(liveCards).toHaveLength(2);
    expect(buildingCards).toHaveLength(1);
  });

  it('흐름 밴드(story #4054 후속, 유나 낱말 정정 2026-09-18) — 4칩 레시피→워크플로우→이벤트→에이전트 순, 현재 칩만 워크플로우+recipe.name', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const band = container.querySelector('[data-testid="recipe-flow-band"]')!;
    expect(band).not.toBeNull();
    const text = band.textContent ?? '';
    expect(text.indexOf('레시피')).toBeLessThan(text.indexOf('워크플로우'));
    expect(text.indexOf('워크플로우')).toBeLessThan(text.indexOf('이벤트'));
    expect(text.indexOf('이벤트')).toBeLessThan(text.indexOf('에이전트'));
    expect(text).toContain(koMessages.recipePreset.videoProductionName); // story #4202 — 플랫폼 프리셋은 messages 문안
    expect(text).toContain('현재 위치 없음');
    // 4번째 칩 라벨이 실행(run 화면과 층 겹침, PO B안)이 아니라 에이전트인지 직접 확認.
    expect(text).toContain('에이전트');
  });

  // story #4067(유나 design-QA, 2026-09-19) — role dot이 status 토큰(bg-info/success/
  // warning/muted-fg/primary/destructive)을 더는 안 쓰고, role KEY 기반 role-accent CSS
  // 변수를 인라인 style로 받는지 pin(className에 status bg-* 없음 + 서로 다른 role이 서로
  // 다른 --role-accent-N을 받는지).
  //
  // ⚠️카디르 재QA(2026-09-19) — 최초 버전은 범례(L74)만 검사해 스텝퍼(L122) 소비부가
  // 되돌아가도(bg-success 복원 등) 이 스위트가 안 틀렸다([못틀리는대조미자]). 범례·스텝퍼
  // 둘 다 같은 assertion을 거치게 헬퍼로 통합 — 어느 한쪽만 되돌려도 이 테스트가 FAIL해야
  // "대조"로서 의미가 있다.
  function assertNoStatusBgAndHasAccentVar(dots: Element[]) {
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      const el = dot as HTMLElement;
      expect(el.className).not.toMatch(/bg-(info|success|warning|muted-foreground|primary|destructive)\b/);
      expect(el.style.backgroundColor).toMatch(/^var\(--role-accent-[1-6]\)$/);
    }
  }

  function roleDots(root: Element, testId: string): Element[] {
    return [...root.querySelector(`[data-testid="${testId}"]`)!.querySelectorAll('span.size-1\\.5.rounded-full')];
  }

  it('범례(L74) role dot이 status bg-* 클래스 대신 role-accent CSS 변수를 인라인 style로 쓴다(회귀)', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const legendDots = roleDots(container, 'recipe-legend');
    assertNoStatusBgAndHasAccentVar(legendDots);
    // 3개 role(크리에이터·디렉터·발행자)이 서로 다른 accent를 받는다(전부 같은 색으로
    // 뭉개지지 않음 — 폴백이 role KEY별로 다르게 동작하는지의 관측 가능한 신호).
    const accents = new Set(legendDots.map((d) => (d as HTMLElement).style.backgroundColor));
    expect(accents.size).toBeGreaterThan(1);
  });

  // 카디르 재QA 핵심 pin — 스텝퍼(L122) 소비부를 직접 검사(범례만으론 못 잡는 자리).
  it('스텝퍼(L122) role dot도 status bg-* 클래스 대신 role-accent CSS 변수를 인라인 style로 쓴다(회귀, 범례와 별개 소비부)', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE} />)); });
    const stepperDots = roleDots(container, 'recipe-stepper');
    // 9 stage 전부 role이 있으니(RECIPE 픽스처) dot도 9개.
    expect(stepperDots).toHaveLength(9);
    assertNoStatusBgAndHasAccentVar(stepperDots);
  });

  // 카디르 재QA 핵심 pin ② — positional(Object.keys 삽입순서) 매핑이 되돌아가면 같은 role이
  // recipe마다 다른 색을 받는다. stage_metadata 키 삽입 순서만 다르고 role 집합은 동일한
  // 두 recipe(A: 크리에이터→디렉터→발행자, B: 발행자→디렉터→크리에이터)를 각각 렌더해
  // "크리에이터"의 accent가 A·B에서 같은지로 이 회귀를 pin한다(positional이면 다름).
  it('role 집합이 같아도 stage_metadata 삽입 순서가 다른 두 recipe에서 같은 role은 같은 accent를 받는다(positional 복원 시 FAIL)', async () => {
    const RECIPE_A: EventDefinitionResponse = {
      ...RECIPE,
      id: 'recipe-a',
      stage_metadata: {
        draft: { role: '크리에이터' },
        concept_confirmed: { role: '디렉터' },
        published: { role: '발행자' },
      },
    };
    const RECIPE_B: EventDefinitionResponse = {
      ...RECIPE,
      id: 'recipe-b',
      stage_metadata: {
        published: { role: '발행자' },
        concept_confirmed: { role: '디렉터' },
        draft: { role: '크리에이터' },
      },
    };

    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE_A} />)); });
    const legendA = new Map(
      [...container.querySelector('[data-testid="recipe-legend"]')!.querySelectorAll('span')]
        .map((s) => [s.textContent?.trim(), (s.querySelector('span.size-1\\.5.rounded-full') as HTMLElement | null)?.style.backgroundColor])
        .filter((pair): pair is [string, string] => pair[1] !== undefined),
    );

    await act(async () => { root.render(wrap(<RecipeDetailView recipe={RECIPE_B} />)); });
    const legendB = new Map(
      [...container.querySelector('[data-testid="recipe-legend"]')!.querySelectorAll('span')]
        .map((s) => [s.textContent?.trim(), (s.querySelector('span.size-1\\.5.rounded-full') as HTMLElement | null)?.style.backgroundColor])
        .filter((pair): pair is [string, string] => pair[1] !== undefined),
    );

    expect(legendA.size).toBeGreaterThan(0);
    expect(legendA.size).toBe(legendB.size);
    for (const [role, accentA] of legendA) {
      expect(legendB.get(role)).toBe(accentA);
    }
  });
});

// story #4174(레시피 2호 블로그) — 발행 승인은 블로그 초안 게이트 하나라(PO 판정 (a)) «발행 승인 대기» 단계에는
// 게이트가 없다. 그 뒤에 게이트 마커가 서면 결재자가 없는 승인 버튼을 찾게 된다(유나 AC).
const BLOG_RECIPE: EventDefinitionResponse = {
  id: 'mkt-blog', key: 'preset.marketing.blog_article', org_id: null,
  name: '블로그 글', description: null,
  payload_schema: {
    properties: {
      stage: {
        enum: ['draft', 'concept_confirmed', 'editing', 'verification', 'pending_approval', 'published', 'publish_checked'],
      },
    },
  },
  stage_metadata: {
    draft: { role: 'Creator' },
    concept_confirmed: { role: 'Director', gate: { type: 'concept_approval', approver: 'org_owner' } },
    editing: { role: 'Creator', capability: { kind: 'draft_site_post' } },
    verification: { role: 'Creator', capability: { kind: 'submit_site_post' } },
    pending_approval: { role: 'Director' },
    published: { role: 'Publisher', capability: { kind: 'site_post_auto_publish' } },
    publish_checked: { role: 'Publisher' },
  },
  enabled: true,
};

describe('RecipeDetailView — 블로그 글(story #4174)', () => {
  it('게이트 마커는 기획 승인 자리 하나뿐 — 발행 승인 대기 뒤에는 서지 않고, 새 단계 라벨이 원시 slug로 안 뜬다', async () => {
    await act(async () => { root.render(wrap(<RecipeDetailView recipe={BLOG_RECIPE} />)); });
    expect(container.querySelector('[data-testid="gate-marker-concept_confirmed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gate-marker-pending_approval"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="gate-marker-"]').length).toBe(1);
    expect(container.textContent).toContain(koMessages.organization.recipeStageLabelPublishChecked);
    expect(container.textContent).not.toContain('publish_checked');
  });
});
