// @vitest-environment jsdom
//
// [SID:4477] 4462 AC3, with the real sheet (no mock): the sheet stays mounted while its closing animation plays, and crossing the
// width back inside that window must not leave it empty. The window is made deterministic: the sheet's popup reports one
// animation whose end the test holds (base-ui waits on `getAnimations()` · `finished` before it unmounts a closing popup) and
// releases after the crossing. RED on 4878's head (4ebefcc1c — the slot adopted the panel only on mount), GREEN since 4882.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import type { FetchedWorkList } from './fetch-work-list';

const { fetchWorkListMock, replaceMock, mobileRef, searchRef, gateReads } = vi.hoisted(() => ({
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
  replaceMock: vi.fn<(href: string) => void>(),
  mobileRef: { current: false },
  searchRef: { current: 'row=t1' },
  gateReads: { held: false, count: 0 },
}));

vi.mock('./fetch-work-list', async (importActual) => ({
  ...(await importActual<typeof import('./fetch-work-list')>()),
  fetchWorkList: (projectId: string) => fetchWorkListMock(projectId),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchRef.current),
  usePathname: () => '/work-list',
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useParams: () => ({ ws: 'moonklabs', proj: 'sprintable' }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobileRef.current }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human', orgId: 'org-1' }), useConnectRulesHref: (p: string) => p }));
vi.mock('@/components/verify/evidence-section', () => ({ EvidenceSection: () => null }));
vi.mock('@/components/canvas/artifact-section', () => ({ ArtifactSection: () => null }));
const gateHigh = { id: 'gh', gate_type: 'deploy', risk_grade: 'high', status: 'pending', work_item_id: 't1', work_item_type: 'task' };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async (url: string) => {
  const u = String(url);
  if (u.startsWith('/api/gates')) {
    gateReads.count += 1;
    if (gateReads.held) return new Promise<Response>(() => {}); // a read that has not answered yet
    return new Response(JSON.stringify([gateHigh]), { status: 200 });
  }
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


// the sheet's closing animation, held by the test: `hold` → the popup reports it; `release()` → it ends
const anim = (() => {
  let resolve: () => void = () => {};
  const a = { hold: false, finished: Promise.resolve(), release: () => resolve() };
  return Object.assign(a, { start() { a.hold = true; a.finished = new Promise<void>((r) => { resolve = r; }); } });
})();

let container: HTMLDivElement;
let root: Root;

function payload(): FetchedWorkList {
  return {
    workList: {
      groups: [{
        goalId: 'g1', title: '목표', isActive: true, doneCount: 0, totalCount: 1, assignedCount: 1, delegatedCount: 0, hypothesisCount: 0,
        stories: [{
          storyId: 's1', title: '스토리', status: 'in-progress', hypothesisIds: [],
          rows: [{ id: 't1', kind: 'task', workItemType: 'task', workItemId: 't1', title: '할일1', ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: 'awaiting_signature' }],
        }],
      }],
      partial: false,
      totalStoryCount: 1,
    },
    hypotheses: [],
  };
}

async function render() {
  const { WorkListShell } = await import('./work-list-shell');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><WorkListShell projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const reason = () => q<HTMLTextAreaElement>('#gate-sig-reason');
const evidenceBox = () => q<HTMLInputElement>('[data-testid="panel-signature-flow"] input[type="checkbox"]');
const tasksTab = () => q('[data-testid="panel-tab-tasks"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWorkListMock.mockReset();
  fetchWorkListMock.mockResolvedValue(payload());
  replaceMock.mockReset();
  mobileRef.current = false;
  searchRef.current = 'row=t1';
  gateReads.held = false; gateReads.count = 0;
  anim.hold = false;
  // jsdom has no Web Animations: only the sheet's popup reports an animation, and only while the test holds one
  (HTMLElement.prototype as unknown as { getAnimations: () => Array<{ finished: Promise<void> }> }).getAnimations = function (this: HTMLElement) {
    return anim.hold && this.matches('[data-slot="sheet-content"]') ? [{ finished: anim.finished }] : [];
  };
});
afterEach(async () => {
  anim.release();
  await act(async () => { root.unmount(); });
  delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  container.remove();
});

describe('[SID:4477] crossing the width back inside the sheet\'s closing animation (the real sheet)', () => {
  it('sheet → aside while the sheet is still closing → sheet again: the panel is in the sheet; after the animation ends too', async () => {
    mobileRef.current = true; await render();
    const panelNode = q('[data-testid="panel-assignee"]');
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode);

    anim.start();
    mobileRef.current = false; await render(); // to the aside: the sheet starts closing and plays its (held) animation
    // the window is real: the closing popup is still mounted, and the panel has moved to the aside
    expect(q('[data-slot="sheet-content"]')).not.toBeNull();
    expect(q('[data-slot="sheet-content"]')!.hasAttribute('data-closed')).toBe(true);
    expect(q('[data-slot="sheet-content"]')!.hasAttribute('data-ending-style')).toBe(true);
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode);

    mobileRef.current = true; await render(); // back before the closing animation ended
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode); // not an empty sheet

    anim.release(); anim.hold = false;
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode);
    expect(panelNode!.isConnected).toBe(true);
  });
});

// the other way (moved here from the mocked-sheet 4462 file · PO 15:00Z): a guard for the opposite direction — it has never been
// broken; the mutation that turns it red is in PR 4894's body
describe('[SID:4477] the opposite direction, with the real sheet (a guard — never broken)', () => {
  it('aside → sheet → aside while the sheet is still closing: the panel stays in the aside; after the animation ends too', async () => {
    await render();
    const panelNode = q('[data-testid="panel-assignee"]');
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode);
    mobileRef.current = true; await render();
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode);

    anim.start();
    mobileRef.current = false; await render(); // back to the aside: the sheet closes and plays its (held) animation
    expect(q('[data-slot="sheet-content"]')!.hasAttribute('data-ending-style')).toBe(true);
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode); // not left in the closing sheet

    anim.release(); anim.hold = false;
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(q('[data-slot="sheet-content"]')).toBeNull();
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode);
    expect(panelNode!.isConnected).toBe(true);
  });
});
