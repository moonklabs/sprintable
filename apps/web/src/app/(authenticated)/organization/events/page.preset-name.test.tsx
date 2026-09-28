// @vitest-environment jsdom
//
// story #4202·#4203(까디르 QA 자리별 회귀 핀) — 조직 이벤트 목록 행(EventDefRow) 제목이 워크플로우 프리셋 이름을
// 로케일 문안으로 그린다. 시드 이름은 언어가 섞여 있어(«Kanban Flow») ko 화면에 영어가 나왔다 — ko·en 둘 다 잰다.
// (#4202 때는 이 목록에 로케일 문안이 걸리는 프리셋이 없어 헬퍼 표지값으로 핀했다 — #4203에서 실제 문안 단언으로.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import enMessages from '../../../../../messages/en.json';

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

const KANBAN = {
  id: 'wf-1', key: 'preset.workflow.kanban', org_id: null,
  name: 'Kanban Flow', description: null,
  payload_schema: { properties: { stage: { enum: ['assign_step_1'] } } },
  routing: {}, block_template: null,
  stage_metadata: { assign_step_1: { role: 'Worker', action: '작업' } },
  enabled: true, version: 1,
};
const ORG_FLOW = { ...KANBAN, id: 'org-1', key: 'org.acme.flow', org_id: 'org-acme', name: '우리 흐름' };

async function renderPage(locale: 'ko' | 'en') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/events/definitions') return { ok: true, json: async () => [KANBAN, ORG_FLOW] };
    return { ok: true, json: async () => ({}) };
  }));
  const { default: OrganizationEventsPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <OrganizationEventsPage />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  const tabLabel = (locale === 'ko' ? koMessages : enMessages).organization.recipeGalleryTabWorkflow;
  const tab = [...document.body.querySelectorAll('[role="tab"], button')].find((el) => el.textContent?.startsWith(tabLabel));
  await act(async () => { (tab as HTMLElement).click(); });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  return document.body.textContent ?? '';
}

describe('/organization/events — 이벤트 목록 행 제목의 워크플로우 프리셋 이름(story #4203)', () => {
  it('ko — 시드의 영어 이름 대신 한국어 문안, 조직 정의는 원문', async () => {
    const text = await renderPage('ko');
    expect(text).toContain(koMessages.recipePreset.workflowKanbanName);
    expect(text).not.toContain('Kanban Flow');
    expect(text).toContain('우리 흐름');
  });

  it('en — 영어 문안', async () => {
    const text = await renderPage('en');
    expect(text).toContain(enMessages.recipePreset.workflowKanbanName);
    expect(text).not.toContain('Kanban Flow');
  });
});
