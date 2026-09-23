// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §1) AC1 계약 핀 고정: 마케팅
// 레시피와 개발 워크플로가 탭으로 분리되고, 각 카드가 단계/게이트/역할 수 배지를 보여주고,
// apply/detail 콜백이 그 레시피 객체로 불린다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CONNECTION_LABEL_KEY, RecipeCardGrid, RecipeGallery } from './recipe-gallery';
import { RECIPE_CONNECTION_TARGETS } from '@/lib/recipe-role-slots';
import { VIDEO_PRODUCTION_RECIPE } from '@/lib/video-production-seed.test.fixture';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

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
  it('마케팅 탭이 기본 활성이고 카드에 단계/게이트 수 배지가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <RecipeGallery marketingRecipes={[MARKETING_RECIPE]} workflowRecipes={[WORKFLOW_RECIPE]} loading={false} error={null} />,
      ));
    });
    expect(container.textContent).toContain('영상 제작 (릴스·쇼츠)');
    expect(container.textContent).toContain('마케팅 워크플로우');
    expect(container.textContent).toContain('개발 워크플로');
    expect(container.textContent).toMatch(/단계\s*3/);
    expect(container.textContent).toMatch(/게이트\s*1/);
    // story #4173 — 역할 수 배지는 뺐다(역할 이름 행과 중복, 유나 앵커 §1).
    expect(container.textContent).not.toMatch(/역할\s*3/);
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

  it('개발 워크플로 탭도 로딩·에러 상태를 처리한다(페드루 QA #4424 qa:changes 재현 — 수정 前엔 바로 빈목록 문구)', async () => {
    async function switchToWorkflowTab() {
      const trigger = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('개발 워크플로'))!;
      await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    }

    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading error={null} />)); });
    await switchToWorkflowTab();
    expect(container.textContent).toContain('불러오는 중');
    expect(container.textContent).not.toContain('표시할 개발 워크플로우가 없어요');

    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading={false} error="boom" />)); });
    await switchToWorkflowTab();
    expect(container.textContent).toContain('워크플로우를 불러오지 못했어요');
    expect(container.textContent).not.toContain('표시할 개발 워크플로우가 없어요');

    await act(async () => { root.render(wrap(<RecipeGallery marketingRecipes={[]} workflowRecipes={[]} loading={false} error={null} />)); });
    await switchToWorkflowTab();
    expect(container.textContent).toContain('표시할 개발 워크플로우가 없어요');
  });
});

// story #4173(유나 디자인 앵커 2026-09-23) — 카드가 필요한 역할 이름·필요한 연결을 보여준다.
// 역할 순서는 적용 다이얼로그 자리와 같은 함수(사람 먼저 → 흐름 순서).
describe('RecipeCardGrid — 역할·연결 행(story #4173)', () => {
  async function renderCards(recipes: EventDefinitionResponse[]) {
    await act(async () => {
      root.render(wrap(<RecipeCardGrid recipes={recipes} loading={false} error={null} emptyMessage="-" />));
    });
    return (id: string) => ({
      roles: container.querySelector(`[data-testid="recipe-card-${id}"] [data-testid="recipe-card-roles"]`)?.textContent,
      connections: container.querySelector(`[data-testid="recipe-card-${id}"] [data-testid="recipe-card-connections"]`)?.textContent,
    });
  }

  const BLOG: EventDefinitionResponse = {
    id: 'blog', key: 'preset.marketing.blog_post', org_id: null, name: '블로그 글', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'review', 'published'] } } },
    stage_metadata: {
      draft: { role: 'Writer' },
      review: { role: 'Editor', gate: { type: 'external_publish', approver: 'org_owner' } },
      published: { role: 'Publisher', capability: { kind: 'publish', target: 'channel_connection' } },
    },
    role_actor_kinds: { Writer: 'agent', Editor: 'human', Publisher: 'agent' },
    enabled: true,
  };
  const NO_CONNECTION: EventDefinitionResponse = {
    id: 'plain', key: 'preset.marketing.comment_reply', org_id: null, name: '댓글 응대', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'approve'] } } },
    stage_metadata: { draft: { role: 'Agent' }, approve: { role: 'Human', gate: { type: 'external_publish', approver: 'org_owner' } } },
    enabled: true,
  };
  const NO_ROLES: EventDefinitionResponse = {
    id: 'signal', key: 'preset.goal.measured', org_id: null, name: '목표 측정', description: null,
    payload_schema: {}, stage_metadata: {}, enabled: true,
  };

  it('영상 레시피(실 seed) — 디렉터(사람) · 크리에이터 · 연산 · 발행자 / 발행 채널 · 연산 커넥터(선택)', async () => {
    const card = await renderCards([VIDEO_PRODUCTION_RECIPE]);
    expect(card(VIDEO_PRODUCTION_RECIPE.id)).toEqual({
      roles: '디렉터(사람) · 크리에이터 · 연산 · 발행자',
      connections: '발행 채널 · 연산 커넥터(선택)',
    });
  });

  it('역할 3개·채널만 필요한 정의 — 사람 역할이 흐름과 무관하게 먼저, 연결은 발행 채널만', async () => {
    const card = await renderCards([BLOG]);
    expect(card('blog').roles).toBe('Editor(사람) · Writer · 발행자');
    expect(card('blog').connections).toBe('발행 채널');
  });

  it('연결이 없는 정의는 행을 숨기지 않고 «없음», role_actor_kinds가 없으면 «(사람)»을 붙이지 않는다', async () => {
    const card = await renderCards([NO_CONNECTION]);
    expect(card('plain')).toEqual({ roles: '에이전트 · 사람', connections: '없음' });
  });

  it('역할이 하나도 없으면 역할 행도 «없음»', async () => {
    const card = await renderCards([NO_ROLES]);
    expect(card('signal')).toEqual({ roles: '없음', connections: '없음' });
  });
});

// 페드루 PO(PR #4547) — 라벨 표를 가드 친화 모양(Record<string, string>)으로 두면서 tsc가 더는
// «target이 늘었는데 라벨 키를 빼먹는» 경우를 못 잡는다 — 여기서 빠짐을 대신 잡는다.
describe('연결 라벨 표 완전성(story #4173)', () => {
  it('RECIPE_CONNECTION_TARGETS 전부가 라벨 표에 있고, 그 키가 ko·en 문구로 실재한다', () => {
    for (const { target } of RECIPE_CONNECTION_TARGETS) {
      const key = CONNECTION_LABEL_KEY[target];
      expect(key, target).toBeDefined();
      expect((koMessages.organization as Record<string, string>)[key!], `ko ${key}`).toBeTruthy();
      expect((enMessages.organization as Record<string, string>)[key!], `en ${key}`).toBeTruthy();
    }
  });
});
