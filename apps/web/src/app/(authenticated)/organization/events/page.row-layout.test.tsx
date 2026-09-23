// @vitest-environment jsdom
//
// story #4212(유나 규격 · 390) — 조직 이벤트 «개발 워크플로» 목록 행(EventDefRow)의 1024 미만 레이아웃 클래스 핀.
// 예전엔 한 줄 flex에서 왼쪽 flex-1(기준 폭 0)이 0까지 줄어 제목 «Un…»·배지가 버튼과 겹쳤고, shrink-0 버튼 묶음이
// 행 밖으로 넘쳤다. 1024 미만은 세로로 쌓고(제목 줄바꿈·버튼 wrap), lg: 이상은 이전 배치 그대로(1440 무변).
// jsdom은 레이아웃을 재지 못하므로 규격 클래스를 핀한다(실측은 유나 design 390·1440).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

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

const PRESET = {
  id: 'wf-1', key: 'preset.workflow.three_step', org_id: null,
  name: 'Three-Step Pipeline', description: null,
  payload_schema: { properties: { stage: { enum: ['assign_step_1', 'submit_step_1'] } } },
  routing: {}, block_template: null,
  stage_metadata: { assign_step_1: { role: 'PO', action: '배정' }, submit_step_1: { role: 'Dev', action: '제출' } },
  enabled: true, version: 1,
};

async function renderWorkflowTab() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/events/definitions') return { ok: true, json: async () => [PRESET] };
    return { ok: true, json: async () => ({}) };
  }));
  const { default: OrganizationEventsPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <OrganizationEventsPage />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  const tab = [...document.body.querySelectorAll('[role="tab"], button')]
    .find((el) => el.textContent?.startsWith(koMessages.organization.recipeGalleryTabWorkflow));
  await act(async () => { (tab as HTMLElement).click(); });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

const classesOf = (el: Element | null) => new Set((el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));

describe('EventDefRow — 390 행 레이아웃(story #4212 유나 규격)', () => {
  it('행: 1024 미만 세로 쌓기 · lg: 이상 이전 한 줄 배치', async () => {
    await renderWorkflowTab();
    const row = classesOf(document.querySelector(`[data-testid="event-def-row-${PRESET.key}"]`));
    for (const c of ['flex', 'flex-col', 'gap-2', 'lg:flex-row', 'lg:flex-wrap', 'lg:items-center', 'lg:justify-between']) {
      expect(row.has(c), c).toBe(true);
    }
    expect(row.has('justify-between'), '1024 미만에 justify-between 없음').toBe(false);
  });

  it('제목: 1024 미만 줄바꿈(말줄임 없음) · lg: 이상 말줄임', async () => {
    await renderWorkflowTab();
    const title = classesOf(document.querySelector(`[data-testid="event-def-toggle-${PRESET.key}"]`));
    expect(title.has('break-words')).toBe(true);
    expect(title.has('lg:truncate')).toBe(true);
    expect(title.has('truncate'), '1024 미만 말줄임 0').toBe(false);
  });

  it('키 부제: 덩어리 폭 안에서만 말줄임', async () => {
    await renderWorkflowTab();
    const sub = classesOf(document.querySelector(`[data-testid="event-def-key-subtitle-${PRESET.key}"]`));
    for (const c of ['min-w-0', 'max-w-full', 'truncate']) expect(sub.has(c), c).toBe(true);
  });

  it('버튼 묶음: 1024 미만 wrap(행 밖 넘침 0) · lg: 이상 한 줄·수축 안 함', async () => {
    await renderWorkflowTab();
    const actions = classesOf(document.querySelector(`[data-testid="event-def-actions-${PRESET.key}"]`));
    for (const c of ['flex', 'flex-wrap', 'lg:shrink-0', 'lg:flex-nowrap']) expect(actions.has(c), c).toBe(true);
    expect(actions.has('shrink-0'), '1024 미만 shrink-0 없음').toBe(false);
  });
});
