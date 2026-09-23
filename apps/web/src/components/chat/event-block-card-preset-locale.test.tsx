// @vitest-environment jsdom
//
// story #4209(유나 확정) — 플랫폼 마케팅·워크플로우 프리셋의 채팅 이벤트 카드: 시드 block_template(한 언어·옛 이름·합니다체·
// 워크플로우는 stage slug 원문)을 로케일 문안으로 — 머리말 «{이름} 워크플로우» · 본문 «**{단계 라벨}** 단계로 넘어갔어요» ·
// «대상» 필드 라벨. 조직 정의는 원문 그대로. event-block-card-recipe-labels.test.tsx와 같은 harness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventBlockCard } from './event-block-card';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// 시드와 같은 모양(0381·0396 마케팅 · 0111 이전 워크플로우 시드)
const MARKETING_TEMPLATE = { blocks: [
  { type: 'header' as const, text: '영상 제작 워크플로우' },
  { type: 'text' as const, text: '**{{label.stage}}** 단계로 넘어갔습니다' },
  { type: 'fields' as const, fields: [{ label: '대상', value: '{{label.work_item_target}}' }] },
] };
const WORKFLOW_TEMPLATE = { blocks: [
  { type: 'header' as const, text: 'Kanban Flow' },
  { type: 'text' as const, text: '**{{payload.stage}}** 로 넘어갔습니다' },
  { type: 'fields' as const, fields: [{ label: '대상', value: '{{payload.work_item_type}} {{payload.work_item_id}}' }] },
] };
const def = (key: string, org_id: string | null, name: string) => ({
  key, org_id, name, payload_schema: {}, routing: {}, block_template: null, enabled: true, version: 1,
});

async function render(locale: 'ko' | 'en', template: typeof MARKETING_TEMPLATE, payload: Record<string, unknown>, definition: ReturnType<typeof def> | null, refs?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <EventBlockCard template={template} payload={payload} definition={definition} refs={refs as never} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container.textContent ?? '';
}

describe('EventBlockCard — 플랫폼 프리셋 카드 문안 로케일(story #4209)', () => {
  it('en · 마케팅 — 머리말 «{name} workflow» · 본문 «Moved to {단계}» · 필드 «Target» · 한국어 0', async () => {
    const text = await render('en', MARKETING_TEMPLATE, { stage: 'draft', work_item_id: 'W-1' }, def('preset.marketing.video_production', null, '영상 제작(릴스·쇼츠)'));
    expect(text).toContain(`${enMessages.recipePreset.videoProductionName} workflow`);
    expect(text).toContain(`Moved to ${enMessages.organization.recipeStageLabelDraft}`);
    expect(text).toContain(enMessages.eventCard.targetLabel);
    expect(text).not.toMatch(/[가-힣]/);
  });

  it('ko · 워크플로우 — 옛 이름 «Kanban Flow»·slug 원문 대신 새 이름·단계 라벨, 해요체', async () => {
    const text = await render('ko', WORKFLOW_TEMPLATE, { stage: 'assign_step_1', work_item_type: 'story', work_item_id: 'W-1' }, def('preset.workflow.kanban', null, 'Kanban Flow'));
    expect(text).toContain(`${koMessages.recipePreset.workflowKanbanName} 워크플로우`);
    expect(text).toContain(`${koMessages.organization.recipeStageLabelAssignStep1} 단계로 넘어갔어요`);
    expect(text).not.toContain('Kanban Flow');
    expect(text).not.toContain('assign_step_1');
    expect(text).not.toContain('넘어갔습니다');
  });

  it('⭐워크플로우 «대상» — `story <UUID>` 원문 0 · 일감 라벨(유나 반려 · PR #4575)', async () => {
    const uuid = '6f1c2e0a-1b2c-4d5e-8f90-123456789abc';
    const text = await render('ko', WORKFLOW_TEMPLATE, { stage: 'assign_step_1', work_item_type: 'story', work_item_id: uuid },
      def('preset.workflow.kanban', null, 'Kanban Flow'), { work_item: { found: true, type: 'story', token: `[로그인 개선](entity:story:${uuid})` } });
    expect(text).not.toContain(uuid);
    expect(text).not.toMatch(/story [0-9a-f-]{36}/);
    expect(text).toContain('로그인 개선');
  });

  it('⭐알려진 시드 모양 밖(단계 문장에 사유가 붙음) → 원문 그대로 · 사유 문구 보존(PR #4575)', async () => {
    const tpl = { blocks: [WORKFLOW_TEMPLATE.blocks[0]!, { type: 'text' as const, text: '**{{payload.stage}}** 로 넘어갔습니다; 사유 {{payload.reason}}' }, WORKFLOW_TEMPLATE.blocks[2]!] };
    const text = await render('ko', tpl as typeof MARKETING_TEMPLATE, { stage: 'assign_step_1', reason: '재배정 요청', work_item_type: 'story', work_item_id: 'W-1' }, def('preset.workflow.kanban', null, 'Kanban Flow'));
    expect(text).toContain('재배정 요청');
  });

  it('조직 정의는 같은 모양이어도 원문 그대로', async () => {
    const text = await render('en', MARKETING_TEMPLATE, { stage: 'draft', work_item_id: 'W-1' }, def('org.acme.video', 'org-1', '우리 영상'));
    expect(text).toContain('영상 제작 워크플로우');
    expect(text).toContain('단계로 넘어갔습니다');
  });

  it('정의를 모르면(구 캐시) 원문 그대로', async () => {
    const text = await render('en', MARKETING_TEMPLATE, { stage: 'draft', work_item_id: 'W-1' }, null);
    expect(text).toContain('영상 제작 워크플로우');
  });
});
