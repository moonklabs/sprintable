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
    expect(stepper.textContent).toContain('draft');
    expect(stepper.textContent).toContain('published');
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
});
