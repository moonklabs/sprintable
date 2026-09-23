// @vitest-environment jsdom
//
// PR #4575 까디르 QA — 조직 → 이벤트의 플랫폼 프리셋 펼친 미리보기(실물 카드)도 채팅과 같은 로케일 문안으로. 예전엔 미리보기가
// EventBlockCard에 definition을 안 넘겨 시드 원문 머리말(«Kanban Flow»·«영상 제작 워크플로우»)·합니다체 본문이 그대로 나왔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventDefinitionSummary } from './event-definition-summary';
import type { EventDefinitionSummary as EventDefinitionSummaryDef } from '@/lib/block-template';
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

// 워크플로우 시드(0260) 모양 그대로.
const SEED_TEMPLATE = { blocks: [
  { type: 'header', text: 'Kanban Flow' },
  { type: 'text', text: '**{{payload.stage}}** 로 넘어갔습니다' },
  { type: 'fields', fields: [{ label: '대상', value: '{{payload.work_item_type}} {{payload.work_item_id}}' }] },
] };
const PAYLOAD_SCHEMA = { properties: { stage: { type: 'string', enum: ['assign_step_1'] } } };

async function renderPreview(definition: { key: string; org_id: string | null; name: string } | undefined) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
        <EventDefinitionSummary
          payloadSchema={PAYLOAD_SCHEMA} routing={{}} actionAuth={null} blockTemplate={SEED_TEMPLATE}
          definition={definition ? ({ ...definition, payload_schema: PAYLOAD_SCHEMA, routing: {}, block_template: SEED_TEMPLATE, enabled: true } as unknown as EventDefinitionSummaryDef) : undefined}
        />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // 미리보기 카드 영역만(고급 JSON 접기 안의 원문 JSON은 제외).
  const details = container.querySelector('details');
  return (container.textContent ?? '').replace(details?.textContent ?? '', '');
}

describe('EventDefinitionSummary 미리보기 — 플랫폼 프리셋은 로케일 문안(PR #4575)', () => {
  it('en · 플랫폼 워크플로우 프리셋 → 머리말 «{name} workflow» · 시드 원문 머리말·합니다체 0', async () => {
    const text = await renderPreview({ key: 'preset.workflow.kanban', org_id: null, name: 'Kanban Flow' });
    expect(text).toContain(`${enMessages.recipePreset.workflowKanbanName} workflow`);
    expect(text).not.toContain('Kanban Flow');
    expect(text).not.toContain('넘어갔습니다');
    // 유나 반려 — «대상»이 ⟨missing⟩ 마커가 아니라 예시 일감.
    expect(text).toContain(enMessages.organization.definerPreviewSampleWorkItem);
    expect(text).not.toMatch(/missing/i);
  });

  it('정의를 안 넘기면(조직 정의 경로와 같은 자리) 원문 그대로 — 위 테스트가 전달을 재는 대조군', async () => {
    const text = await renderPreview(undefined);
    expect(text).toContain('Kanban Flow');
  });
});
