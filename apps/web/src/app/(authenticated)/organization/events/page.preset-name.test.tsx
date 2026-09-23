// @vitest-environment jsdom
//
// story #4202(까디르 QA) — 자리별 회귀 핀: 조직 이벤트 목록 행(EventDefRow) 제목이 presetName을 거친다.
// 마케팅 프리셋은 이 목록이 아니라 «마케팅» 탭 카드로 가서(recipeKeyDomain 필터) 지금 이 행에 로케일 문안이
// 실제로 걸리는 프리셋은 없다 — 워크플로우 프리셋 키는 story #4203에서 표에 오른다. 그래서 en 문자열 대신
// 헬퍼를 표지값을 내는 가짜로 바꿔 «행이 원문 name이 아니라 presetName 결과를 그린다»를 핀한다(원문 복귀 → RED).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

vi.mock('@/lib/platform-preset-copy', () => ({
  presetName: (def: { key: string }) => `PRESET_NAME(${def.key})`,
  presetDescription: (def: { key: string }) => `PRESET_DESC(${def.key})`,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/organization/events',
}));

let container: HTMLDivElement;
let root: Root;

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

const WORKFLOW_PRESET = {
  id: 'wf-1', key: 'preset.workflow.scrum_3step', org_id: null,
  name: '3단계 스크럼', description: null,
  payload_schema: { properties: { stage: { enum: ['kickoff', 'qa_review'] } } },
  routing: {}, block_template: null,
  stage_metadata: { kickoff: { role: 'PO', action: '명세' }, qa_review: { role: 'QA', action: '검증' } },
  enabled: true, version: 1,
};

describe('/organization/events — 이벤트 목록 행 제목이 presetName을 거친다(story #4202)', () => {
  it('프리셋 행 제목 = presetName 결과(원문 name 아님)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/events/definitions') return { ok: true, json: async () => [WORKFLOW_PRESET] };
      return { ok: true, json: async () => ({}) };
    }));
    const { default: OrganizationEventsPage } = await import('./page');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrganizationEventsPage /></NextIntlClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    const tab = [...document.body.querySelectorAll('[role="tab"], button')].find((el) => el.textContent?.startsWith('개발 워크플로우'));
    await act(async () => { (tab as HTMLElement).click(); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(document.body.textContent).toContain('PRESET_NAME(preset.workflow.scrum_3step)');
    expect(document.body.textContent).not.toContain('3단계 스크럼');
  });
});
