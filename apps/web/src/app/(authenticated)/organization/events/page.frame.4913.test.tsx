// @vitest-environment jsdom
//
// 4913(UI-R5) C2 — 이벤트(레시피) 화면이 «한 쪽 틀» 안에 선다: 제목은 위 막대(h1 하나) · 본문은 reading 틀 · 머리 = 설명 + «새 워크플로우» ·
// 탭 둘(마케팅 · 개발) · 목록은 RowList(우클릭 = «⋯» 같은 항목 · 더블클릭 / Enter = 펼침 · 한 번에 하나) · 빈 / 로딩 / 오류 칸 · 정의 만들기 창.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.organization;
const ORG_ID = 'org-1';

let container: HTMLDivElement;
let root: Root;

function asRole(role: 'admin' | 'member') {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role }],
    projectMemberships: [],
    currentTeamMemberId: 'member-me-1',
  });
}

const CUSTOM = {
  id: 'def-1', key: 'org.moonklabs.work.decision', name: '작업 판단', org_id: ORG_ID,
  payload_schema: { type: 'object', properties: {}, additionalProperties: false },
  routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } },
  block_template: null, enabled: true, version: 1,
};
const CUSTOM_B = { ...CUSTOM, id: 'def-2', key: 'org.moonklabs.work.second', name: '둘째 판단' };
const PRESET = { ...CUSTOM, id: undefined, key: 'preset.gate.verdict', name: '게이트 판정', org_id: null, version: 2 };

function stubFetch(opts: { defs?: unknown[]; hang?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === '/api/events/definitions' && (!init || !init.method || init.method === 'GET')) {
      if (opts.hang) return new Promise(() => {});
      return { ok: true, json: async () => opts.defs ?? [] };
    }
    if (url.startsWith('/api/events/definitions/publish-history')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({}) };
  }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function mount(tab: 'marketing' | 'workflow' = 'workflow') {
  const { default: Page } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  function Probe() {
    const { title } = useTopBar();
    return <div data-testid="topbar-probe">{title}</div>;
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><Probe /><Page /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await flush();
  if (tab === 'workflow') {
    const trigger = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.startsWith(T.recipeGalleryTabWorkflow)) as HTMLElement;
    await act(async () => { trigger.click(); });
    await flush();
  }
}

const rowOf = (key: string) => container.querySelector(`[data-testid="event-def-row-${key}"]`) as HTMLElement;
const mainOf = (key: string) => rowOf(key).querySelector('[data-row-main]') as HTMLElement;
const menuLabels = () => [...document.body.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
const openKeys = () => [...container.querySelectorAll('[data-slot="ds-row-list-item"][data-open]')].map((e) => e.getAttribute('data-testid'));
const keyOn = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  asRole('admin');
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('OrganizationEventsPage — 한 쪽 틀(4913 C2)', () => {
  it('⭐제목은 위 막대의 h1 하나뿐이고(본문 h1 0) 본문은 reading 틀(PageFrame) 안에 선다', async () => {
    stubFetch({ defs: [CUSTOM] });
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(T.eventsTitle);
    expect(container.querySelector('[data-testid="topbar-probe"] h1')).not.toBeNull();
    const frame = container.querySelector('[data-slot="ds-page-frame"]')!;
    expect(frame.getAttribute('data-width')).toBe('reading');
    expect(frame.querySelector('h1')).toBeNull();
    // 머리 설명은 틀 안
    expect(frame.textContent).toContain(T.eventsDescription);
  });

  it('⭐«새 워크플로우»는 관리자에게만 머리 오른쪽에 서고, 누르면 정의 만들기 창이 열린다', async () => {
    stubFetch({ defs: [CUSTOM] });
    await mount();
    const create = [...container.querySelectorAll('[data-slot="ds-page-frame"] button')].find((b) => b.textContent === T.eventCreateCta) as HTMLElement;
    expect(create).toBeDefined();
    await act(async () => { create.click(); });
    await flush();
    expect(document.body.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
  });

  it('일반 멤버에겐 «새 워크플로우»가 없고 읽기 전용 안내(Banner)가 뜬다', async () => {
    asRole('member');
    stubFetch({ defs: [CUSTOM] });
    await mount();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === T.eventCreateCta)).toBe(false);
    expect(container.querySelector('[data-slot="ds-banner"]')?.textContent).toContain(T.eventReadonlyNotAdmin);
  });

  it('⭐탭은 둘(마케팅이 기본 · 개발)이고 마케팅 탭의 목록은 RowList(recipe-list)다', async () => {
    stubFetch({ defs: [CUSTOM] });
    await mount('marketing');
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.textContent).toContain(T.recipeGalleryTabMarketing);
    expect(tabs[1]!.textContent).toContain(T.recipeGalleryTabWorkflow);
    // 옛 3열 카드 격자는 없다
    expect(container.querySelector('[class*="grid-cols-3"], [class*="lg:grid-cols"]')).toBeNull();
  });

  it('⭐개발 탭: 커스텀 · 프리셋 두 RowList(이름 = 그룹 제목)이고 정의 하나 = 행 하나(listitem)다', async () => {
    stubFetch({ defs: [CUSTOM, CUSTOM_B, PRESET] });
    await mount();
    const custom = container.querySelector('[data-testid="events-custom-list"] [role="list"]')!;
    const preset = container.querySelector('[data-testid="events-preset-list"] [role="list"]')!;
    expect(custom.getAttribute('aria-label')).toBe(T.eventsCustomGroupTitle);
    expect(preset.getAttribute('aria-label')).toBe(T.eventsPresetGroupTitle);
    expect(custom.querySelectorAll('[role="listitem"][data-testid^="event-def-row-"]')).toHaveLength(2);
    expect(preset.querySelectorAll('[role="listitem"][data-testid^="event-def-row-"]')).toHaveLength(1);
  });

  it('⭐행 우클릭 = 그 행 «⋯» 메뉴와 같은 항목이다(같은 배열)', async () => {
    stubFetch({ defs: [CUSTOM] });
    await mount();
    const trigger = rowOf(CUSTOM.key).querySelector('[data-slot="ds-row-context-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30, button: 2 })); });
    const viaContext = menuLabels();
    expect(viaContext).toEqual([T.eventTestPublishCta, T.eventEditCta, T.eventDeactivateCta]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const more = rowOf(CUSTOM.key).querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement;
    await act(async () => { more.click(); });
    expect(menuLabels()).toEqual(viaContext);
  });

  it('⭐«⋯» 단추의 접근 이름은 «몇 번째 · 행 이름»이다(보조기술 단추 목록에서 행마다 같은 이름이 되지 않게)', async () => {
    stubFetch({ defs: [CUSTOM, CUSTOM_B] });
    await mount();
    const label = (key: string) => rowOf(key).querySelector('[data-slot="ds-row-actions-trigger"]')!.getAttribute('aria-label');
    const fmt = (n: number, name: string) => T.eventRowActionAriaLabel.replace('{n}', String(n)).replace('{label}', name);
    expect(label(CUSTOM.key)).toBe(fmt(1, CUSTOM.name));
    expect(label(CUSTOM_B.key)).toBe(fmt(2, CUSTOM_B.name));
    expect(label(CUSTOM.key)).not.toBe(label(CUSTOM_B.key));
  });

  it('⭐더블클릭 = 펼침 · Enter = 펼침/접힘 · Esc = 접힘 — 한 번에 한 행만 열린다', async () => {
    stubFetch({ defs: [CUSTOM, CUSTOM_B] });
    await mount();
    expect(openKeys()).toEqual([]);
    await act(async () => { mainOf(CUSTOM.key).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(openKeys()).toEqual([`event-def-row-${CUSTOM.key}`]);
    mainOf(CUSTOM.key).focus();
    await keyOn(mainOf(CUSTOM.key), 'Escape');
    expect(openKeys()).toEqual([]);
    mainOf(CUSTOM.key).focus();
    await keyOn(mainOf(CUSTOM.key), 'Enter');
    expect(openKeys()).toEqual([`event-def-row-${CUSTOM.key}`]);
    mainOf(CUSTOM_B.key).focus();
    await keyOn(mainOf(CUSTOM_B.key), 'Enter');
    expect(openKeys()).toEqual([`event-def-row-${CUSTOM_B.key}`]);
    await keyOn(mainOf(CUSTOM_B.key), 'Enter');
    expect(openKeys()).toEqual([]);
  });

  it('행 안 단추(«프로젝트에 적용» · «⋯»)를 더블클릭해도 줄이 열리지 않는다', async () => {
    const cyc = { ...CUSTOM, payload_schema: { type: 'object', properties: { stage: { enum: ['draft', 'published'] } }, additionalProperties: false }, stage_metadata: { draft: { role: 'A' }, published: { role: 'B' } } };
    stubFetch({ defs: [cyc] });
    await mount();
    const apply = [...rowOf(CUSTOM.key).querySelectorAll('button')].find((b) => b.textContent === T.eventApplyCta)!;
    await act(async () => { apply.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(openKeys()).toEqual([]);
  });

  it('펼친 칸은 접혀 있는 동안 그리지 않는다(펼침 칸 = 행 오른쪽 쉐브론 aria-expanded)', async () => {
    stubFetch({ defs: [CUSTOM] });
    await mount();
    expect(container.querySelector(`[data-testid="event-def-detail-${CUSTOM.key}"]`)).toBeNull();
    const chevron = rowOf(CUSTOM.key).querySelector('[aria-expanded]') as HTMLElement;
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { chevron.click(); });
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector(`[data-testid="event-def-detail-${CUSTOM.key}"]`)).not.toBeNull();
  });

  it('⭐정의가 없으면 목록 안에 빈 칸(EmptyState) — 그룹 둘 다', async () => {
    stubFetch({ defs: [] });
    await mount();
    const empties = container.querySelectorAll('[data-slot="ds-page-frame"] [role="list"] [data-slot="ds-empty-state"]');
    expect(empties).toHaveLength(2);
    expect(container.querySelector('[data-testid="events-custom-list"]')?.textContent).toContain(T.eventsEmpty);
  });

  it('⭐불러오는 동안 개발 탭은 틀 안 로딩 칸(role=status · aria-busy) — 목록은 아직 없다', async () => {
    stubFetch({ hang: true });
    await mount();
    const status = container.querySelector('[data-slot="ds-page-frame"] [role="status"][aria-busy="true"]');
    expect(status).not.toBeNull();
    expect(container.querySelector('[data-testid="events-custom-list"]')).toBeNull();
  });
});
