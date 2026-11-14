// @vitest-environment jsdom
//
// story #4212(유나 규격 · 390) → 4913 C2 — 조직 이벤트 «개발 워크플로» 목록 행(EventDefRow)의 좁은 폭 규격.
// 옛 판: 손으로 만든 한 줄 flex가 390에서 제목 «Un…»·배지가 버튼과 겹치고 단추 묶음이 행 밖으로 넘쳤다(4212·4215) → 1024 미만 세로 쌓기 클래스를 핀했다.
// 새 판: 행은 틀의 `RowListItem`(ds ListRow) — 제목 한 줄 잘림 · 오른쪽 묶음(칩 · 적용 · «⋯»)이 모자라면 둘째 줄 오른쪽으로(공용 ListRow 줄바꿈) · 부제(코드 키)는 한 줄 말줄임. 실제 폭은 레이아웃 e2e가 잰다 — jsdom은 폭을 못 재 규격 클래스를 핀한다.
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

async function renderWorkflowTab(def: typeof PRESET = PRESET) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/events/definitions') return { ok: true, json: async () => [def] };
    return { ok: true, json: async () => ({}) };
  }));
  const { default: OrganizationEventsPage } = await import('./page');
  // 4913 C2 — 화면 제목은 앱 틀 위 막대(TopBarSlot)로 간다: 막대 컨텍스트는 화면과 같은 번(모듈 비움 뒤)에 불러온다 — 정적으로 불러오면 컨텍스트가 둘이 된다.
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><OrganizationEventsPage /></TopBarProvider>
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
const rowEl = () => document.querySelector(`[data-testid="event-def-row-${PRESET.key}"]`)!;
const listRow = () => rowEl().querySelector('[data-slot="ds-list-row"]')!;

describe('EventDefRow — 행 레이아웃(RowList · 4212 규격을 틀의 행이 이어받음)', () => {
  it('행은 RowList(role=list · 이름) 안의 listitem이고 한 줄(ListRow)이 줄바꿈을 허용한다', async () => {
    await renderWorkflowTab();
    expect(rowEl().getAttribute('role')).toBe('listitem');
    expect(rowEl().closest('[role="list"]')?.getAttribute('aria-label')).toBe(koMessages.organization.eventsPresetGroupTitle);
    expect(classesOf(listRow()).has('flex-wrap'), '오른쪽 묶음이 모자라면 둘째 줄로').toBe(true);
  });

  it('제목: 한 줄 말줄임(잘린 글도 DOM에 전부) — 칩 · 단추와 겹치지 않는다', async () => {
    await renderWorkflowTab();
    const title = listRow().querySelector('.font-semibold')!;
    expect(classesOf(title).has('truncate')).toBe(true);
    expect(title.textContent).toBeTruthy();
  });

  it('⭐공백 없는 60자 제목도 행 안에서 한 줄로 잘리고(truncate · min-w-0 칸) 전문은 DOM에 남는다(story #4215 까디르 QA)', async () => {
    const longTitle = 'Supercalifragilisticexpialidocious_workflow_identifier_60chx';
    expect(longTitle).toHaveLength(60);
    expect(longTitle).not.toMatch(/\s/);
    // 로케일 문안 표(platform-preset-copy)에 없는 키 — 표시명이 name 그대로 나오는 자리.
    const def = { ...PRESET, key: 'preset.workflow.long_title_fixture', name: longTitle };
    await renderWorkflowTab(def);
    const row = document.querySelector(`[data-testid="event-def-row-${def.key}"] [data-slot="ds-list-row"]`)!;
    const title = row.querySelector('.font-semibold')!;
    expect(title.textContent).toContain(longTitle);
    expect(classesOf(title).has('truncate')).toBe(true);
    expect(classesOf(title.parentElement).has('min-w-0'), '제목 칸이 줄어들 수 있다').toBe(true);
  });

  it('키 부제: 한 줄 말줄임(코드 글꼴)', async () => {
    await renderWorkflowTab();
    const sub = document.querySelector(`[data-testid="event-def-key-subtitle-${PRESET.key}"]`)!;
    const cell = sub.parentElement!;
    expect(classesOf(cell).has('truncate'), 'truncate').toBe(true);   // the second line still truncates on one line
    expect(classesOf(sub).has('font-mono'), 'font-mono').toBe(true); // 4928: the key is a DataText (code font) inside a body-font line
  });

  it('오른쪽 묶음(활성 · 버전 칩 · «프로젝트에 적용»): 오른쪽 끝에 붙은 채 줄바꿈 · 행 밖으로 안 넘친다(max-w-full)', async () => {
    await renderWorkflowTab();
    const group = listRow().querySelector('[data-slot="ds-chip"]')!.parentElement!;
    for (const c of ['flex', 'flex-wrap', 'ml-auto', 'justify-end', 'max-w-full']) expect(classesOf(group).has(c), c).toBe(true);
  });
});
