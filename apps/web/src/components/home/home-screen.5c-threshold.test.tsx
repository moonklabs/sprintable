// @vitest-environment jsdom
//
// story 5031 (C1 step 5c · PO ii) — the REAL home screen: the detail column exists only when the body received ≥ 716 (home-layout.ts); below that the detail is the sheet and the list is the whole body (ListDetailShell, `fixed` + not wide = one column).
// ResizeObserver and the body's width are stubbed (jsdom has no layout); the real width rule is measured in Chromium (e2e/home-settings-5c.5031.layout.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { TodaySnapshot } from '../org-briefing/derive-today';
import { deriveHome } from './derive-home';
import { HOME_TWO_COLUMN_MIN } from './home-layout';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ro = vi.hoisted(() => ({ cbs: [] as Array<() => void>, width: 0 }));
class FakeRO { constructor(cb: () => void) { ro.cbs.push(cb); } observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ro.cbs.length = 0;
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: ro.width, height: 0, top: 0, left: 0, right: ro.width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(width: number) {
  ro.width = width;
  const { HomeScreen } = await import('./home-screen');
  const snapshot = { needsMe: [{ id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'story', workItemId: 's1', workItemTitle: '가입 문구 발행', requestedByName: '에이전트', reason: null, createdAt: '2026-11-11T09:00:00Z', conversationId: null, conversationProjectId: null, recipePublish: false, projectId: null }], needsMeCount: 1, agentProgress: [] } as unknown as TodaySnapshot;
  const model = deriveHome({ snapshot, notifications: [], stories: [], completedToday: [], viewerMemberId: null });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HomeScreen model={model} sources={{ snapshot, notificationHrefById: {}, runConversationById: {} }} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}
const column = () => container.querySelector('[data-testid="home-detail-column"]');
const rootEl = () => container.querySelector('[data-testid="home-screen"]') as HTMLElement;

describe('HomeScreen — the two-column threshold comes from the body\'s own width', () => {
  it('⭐body 716 → two columns: the detail column is drawn and the grid is the 340 split', async () => {
    await mount(HOME_TWO_COLUMN_MIN);
    expect(column()).not.toBeNull();
    expect(rootEl().className).toContain('lg:grid-cols-[minmax(0,1fr)_340px]');
  });
  it('⭐body 715 → the sheet: no detail column, and the grid is ONE column (no empty 340 track though the window is past lg)', async () => {
    await mount(HOME_TWO_COLUMN_MIN - 1);
    expect(column()).toBeNull();
    expect(rootEl().className).toContain('lg:grid-cols-[minmax(0,1fr)]');
    expect(rootEl().className).not.toContain('340px');
  });
  it('the home hands the shell the measured width (a wrapper with the ref) — source pin', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.join(__dirname, 'home-screen.tsx'), 'utf8');
    expect(src).toContain('useDetailBesideList(HOME_TWO_COLUMN_MIN)');
    expect(src).toContain('ref={bodyRef}');
  });
});
