// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 4슬롯 적용 다이얼로그 계약 핀 고정(PO 判定 2026-09-18,
// story #4046): 크리에이터만 실제 role_mapping으로 제출되고, 디렉터는 게이트 approver를
// 읽기 전용으로 보여주며, 연산·발행자 picker는 비활성(이 카드 범위 밖)이다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MarketingRecipeApplyDialog } from './marketing-recipe-apply-dialog';
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const RECIPE: EventDefinitionResponse & { id: string } = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: null,
  payload_schema: { properties: { stage: { enum: ['draft', 'animatic', 'concept_confirmed', 'published'] } } },
  stage_metadata: {
    draft: { role: '크리에이터' },
    animatic: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
    published: { role: '발행자' },
  },
  enabled: true,
};

function stubMemberFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members')) {
      return {
        ok: true,
        json: async () => [
          { id: 'agent-1', name: '댄', type: 'agent' },
          { id: 'human-1', name: '윤재', type: 'human' },
        ],
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

describe('MarketingRecipeApplyDialog — 4슬롯 다른 메커니즘', () => {
  it('디렉터는 게이트 approver를 읽기 전용으로 보여준다(role_mapping 아님)', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const approverEl = document.body.querySelector('[data-testid="director-approver"]');
    expect(approverEl?.textContent).toBe('org_owner');
  });

  it('크리에이터 select는 프로젝트 선택 뒤 agent 타입만(human 제외) 채워진다', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    const optionTexts = [...creatorSelect.options].map((o) => o.textContent);
    expect(optionTexts).toContain('댄');
    expect(optionTexts).not.toContain('윤재');
  });

  it('연산·발행자 select는 비활성(이 카드 범위 밖)', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const computeSelect = document.body.querySelector('[data-testid="slot-compute"] select') as HTMLSelectElement;
    const publisherSelect = document.body.querySelector('[data-testid="slot-publisher"] select') as HTMLSelectElement;
    expect(computeSelect.disabled).toBe(true);
    expect(publisherSelect.disabled).toBe(true);
  });

  it('제출은 크리에이터 role_mapping만 담아 onSubmit을 부른다(디렉터·발행자 stage는 안 실림)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
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
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1',
      projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1' },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
