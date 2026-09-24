// @vitest-environment jsdom
//
// story #4086 — 레시피 사이클형 정의(preset.marketing.video_production 등)의 단계
// 알림 block_template이 {{label.stage}}·{{label.work_item_target}}로 raw slug/uuid를
// 해소하는지 실 렌더로 확認한다. org-gate-policy-section.test.tsx와 동형 harness
// (NextIntlClientProvider+createRoot+jsdom, global fetch stub).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventBlockCard } from './event-block-card';
import koMessages from '../../../messages/ko.json';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1' });
  // domainLabels 훅(useOrgDomainLabels)의 BFF 호출 — stage/work_item_target 해소와
  // 무관하니 빈 목록으로 무해하게 응답(호출 자체를 막지 않는다 — 실 훅 그대로).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) })),
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const RECIPE_TEMPLATE = {
  blocks: [
    { type: 'header' as const, text: '영상 제작 레시피' },
    // 유나 design CHANGES(PR #4463 코멘트 5756079751) — 라벨 뒤 조사 「로」가 받침 있는
    // stage 라벨(초안·확정·애니매틱·생성·검증·편집·발행)에서 틀려(«초안로») 고정 접미어
    // 「단계로」로 우회(0385 마이그 실 텍스트와 동일).
    { type: 'text' as const, text: '**{{label.stage}}** 단계로 넘어갔습니다' },
    {
      type: 'fields' as const,
      fields: [{ label: '대상', value: '{{label.work_item_target}}' }],
    },
  ],
};

describe('EventBlockCard — story #4086 레시피 단계 라벨 해소', () => {
  it('⭐{{label.stage}}가 raw slug(draft) 대신 한글 라벨(초안)로 렌더된다', async () => {
    await act(async () => {
      root.render(
        wrap(
          <EventBlockCard
            template={RECIPE_TEMPLATE}
            payload={{ stage: 'draft', work_item_type: 'story', work_item_id: '11111111-1111-1111-1111-111111111111' }}
            refs={{ work_item: { found: true, token: '[캠페인 아이디어](entity:story:11111111-1111-1111-1111-111111111111)' } }}
          />,
        ),
      );
    });
    await flush();

    expect(container.textContent).toContain('초안');
    expect(container.textContent).not.toContain('draft');
  });

  it('⭐{{label.work_item_target}}이 raw "story {uuid}" 대신 참조 토큰(제목)으로 렌더된다', async () => {
    await act(async () => {
      root.render(
        wrap(
          <EventBlockCard
            template={RECIPE_TEMPLATE}
            payload={{ stage: 'draft', work_item_type: 'story', work_item_id: '11111111-1111-1111-1111-111111111111' }}
            refs={{ work_item: { found: true, token: '[캠페인 아이디어](entity:story:11111111-1111-1111-1111-111111111111)' } }}
          />,
        ),
      );
    });
    await flush();

    expect(container.textContent).toContain('캠페인 아이디어');
    expect(container.textContent).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(container.textContent).not.toContain('story 11111111');
  });

  it('9 stage 전부 recipe-stage-label.ts 테이블대로 해소된다(등재 slug 전수)', async () => {
    const EXPECTED: Record<string, string> = {
      draft: koMessages.organization.recipeStageLabelDraft,
      concept_confirmed: koMessages.organization.recipeStageLabelConceptConfirmed,
      animatic: koMessages.organization.recipeStageLabelAnimatic,
      structure_passed: koMessages.organization.recipeStageLabelStructurePassed,
      live_generation: koMessages.organization.recipeStageLabelLiveGeneration,
      verification: koMessages.organization.recipeStageLabelVerification,
      editing: koMessages.organization.recipeStageLabelEditing,
      pending_approval: koMessages.organization.recipeStageLabelPendingApproval,
      published: koMessages.organization.recipeStageLabelPublished,
    };
    for (const [slug, label] of Object.entries(EXPECTED)) {
      await act(async () => {
        root.render(
          wrap(
            <EventBlockCard
              template={RECIPE_TEMPLATE}
              payload={{ stage: slug, work_item_type: 'story', work_item_id: '11111111-1111-1111-1111-111111111111' }}
              refs={{}}
            />,
          ),
        );
      });
      await flush();
      expect(container.textContent, `stage=${slug}`).toContain(label);
      // ⭐PO CHANGES pin — 받침 유무와 무관하게 「단계로」 고정 접미어라 9 stage 전부
      // 조사 결합이 항상 맞다(라벨 자체에 조사를 붙이지 않는 설계 그 자체를 증명).
      expect(container.textContent, `stage=${slug}`).toContain(`${label} 단계로`);
    }
  });

  it('미등재 stage는 raw slug 그대로(지어내지 않음, recipeStageLabel pass-through 계약)', async () => {
    await act(async () => {
      root.render(
        wrap(
          <EventBlockCard
            template={RECIPE_TEMPLATE}
            payload={{ stage: 'not_a_registered_stage', work_item_type: 'story', work_item_id: '1' }}
            refs={{}}
          />,
        ),
      );
    });
    await flush();

    expect(container.textContent).toContain('not_a_registered_stage');
  });
});

// story #4249(유나 design ⑥) — 레시피 stage 카드는 그 stage 담당(refs.stage_assignee)이 보는 사람일 때만 «스토리 보기» 링크.
describe('EventBlockCard — 담당에게만 «스토리 보기»(story #4249)', () => {
  const TEMPLATE = { blocks: [{ type: 'header' as const, text: '헤더' }] };
  const PAYLOAD = { stage: 'assign_step_1', work_item_type: 'story', work_item_id: 'story-9' };

  it('담당 = 나 → 스토리 링크 · 담당 ≠ 나 · 담당 모름 → 링크 없음', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1', currentTeamMemberId: 'me-1' });
    await act(async () => { root.render(wrap(<EventBlockCard template={TEMPLATE} payload={PAYLOAD} refs={{ stage_assignee: 'me-1' }} />)); });
    await flush();
    const link = container.querySelector('[data-testid="event-card-view-story"]');
    expect(link?.textContent).toBe(koMessages.eventCard.viewStory);
    expect(link?.getAttribute('href')).toContain('/board?story=story-9');

    await act(async () => { root.render(wrap(<EventBlockCard template={TEMPLATE} payload={PAYLOAD} refs={{ stage_assignee: 'someone-else' }} />)); });
    await flush();
    expect(container.querySelector('[data-testid="event-card-view-story"]')).toBeNull();

    await act(async () => { root.render(wrap(<EventBlockCard template={TEMPLATE} payload={PAYLOAD} refs={{}} />)); });
    await flush();
    expect(container.querySelector('[data-testid="event-card-view-story"]')).toBeNull();
  });
});
