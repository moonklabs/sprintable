// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §1) AC1 계약 핀 고정: 마케팅
// 레시피와 개발 워크플로가 탭으로 분리되고, 각 카드가 단계/게이트/역할 수 배지를 보여주고,
// apply/detail 콜백이 그 레시피 객체로 불린다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { RecipeGallery } from './recipe-gallery';
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

// #4039 seed shape(recipe-role-slots.test.ts와 동일 fixture 축소판) — 단계 3(디렉터1·
// 크리에이터1·발행자1)·게이트 1.
const MARKETING_RECIPE: EventDefinitionResponse = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: '소재 확정부터 발행까지.',
  payload_schema: { properties: { stage: { enum: ['draft', 'concept_confirmed', 'published'] } } },
  stage_metadata: {
    draft: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
    published: { role: '발행자' },
  },
  enabled: true,
};

const WORKFLOW_RECIPE: EventDefinitionResponse = {
  id: 'wf-1', key: 'preset.workflow.dev_flow', org_id: null,
  name: '3단계 스크럼', description: null,
  payload_schema: {}, stage_metadata: {}, enabled: true,
};

describe('RecipeGallery — 마케팅/워크플로 탭 분리(AC1)', () => {
  it('마케팅 탭이 기본 활성이고 카드에 단계/게이트/역할 수 배지가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <RecipeGallery marketingRecipes={[MARKETING_RECIPE]} workflowRecipes={[WORKFLOW_RECIPE]} loading={false} error={null} />,
      ));
    });
    expect(container.textContent).toContain('영상 제작 (릴스·쇼츠)');
    expect(container.textContent).toContain('마케팅 워크플로우');
    expect(container.textContent).toContain('개발 워크플로');
    // 단계 3·게이트 1·역할 2(디렉터·크리에이터·발행자 3종이지만 표시는 recipeGalleryRoleCountBadge 값)
    expect(container.textContent).toMatch(/단계\s*3/);
    expect(container.textContent).toMatch(/게이트\s*1/);
    expect(container.textContent).toMatch(/역할\s*3/);
  });

  it('apply/detail 버튼이 그 레시피 객체로 콜백을 부른다', async () => {
    const onApply = vi.fn();
    const onViewDetail = vi.fn();
    await act(async () => {
      root.render(wrap(
        <RecipeGallery
          marketingRecipes={[MARKETING_RECIPE]} workflowRecipes={[]} loading={false} error={null}
          onApply={onApply} onViewDetail={onViewDetail}
        />,
      ));
    });
    const buttons = [...container.querySelectorAll('button')];
    const applyBtn = buttons.find((b) => b.textContent === '프로젝트에 적용');
    const detailBtn = buttons.find((b) => b.textContent === '상세 보기');
    await act(async () => { applyBtn!.click(); });
    await act(async () => { detailBtn!.click(); });
    expect(onApply).toHaveBeenCalledWith(MARKETING_RECIPE);
    expect(onViewDetail).toHaveBeenCalledWith(MARKETING_RECIPE);
  });

  it('로딩·에러·빈 상태 문구가 각각 뜬다(회귀 0 — 셋 다 다른 조건)', async () => {
    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading error={null} />)); });
    expect(container.textContent).toContain('불러오는 중');

    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading={false} error="boom" />)); });
    expect(container.textContent).toContain('워크플로우를 불러오지 못했어요');

    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading={false} error={null} />)); });
    expect(container.textContent).toContain('표시할 워크플로우가 없어요');
  });
});
