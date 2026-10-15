// @vitest-environment jsdom
//
// [SID:4456] The detail panel is not mounted again when the width crosses the 1024 px breakpoint (desktop aside ↔ mobile sheet).
// Measured (local · real shell): the round trip remounted the panel — the «근거 확인» check and the chosen tab were lost and the
// gate dropped to «loading» (≈2 s blank on dev). The panel now renders once, through a stable host node that the aside or the
// sheet adopts; only the outer shell changes. The sheet's own focus handling is pinned too (PO 07:18Z): focus moves into the
// sheet, Esc closes it, and focus goes back to the row that opened it.
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
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('[SID:4456] a width round trip (aside → sheet → aside) keeps the panel', () => {
  it('the same panel node · the «근거 확인» check · the chosen tab · the state line and the sign button all stay', async () => {
    await render();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(reason(), '배포 근거 확인함'); reason()!.dispatchEvent(new Event('input', { bubbles: true }));
      evidenceBox()!.click();
      const tab = tasksTab()!;
      tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      tab.click();
    });
    expect(evidenceBox()!.checked).toBe(true);
    expect(tasksTab()!.getAttribute('aria-selected')).toBe('true');
    const panelNode = q('[data-testid="panel-assignee"]');
    const readsBefore = gateReads.count;
    gateReads.held = true; // were the panel read again, the line would drop while this read hangs

    mobileRef.current = true; await render();
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode); // inside the sheet · the same node
    expect(q('[data-testid="panel-state"]')).not.toBeNull();
    mobileRef.current = false; await render();

    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode); // back in the aside · still the same node
    expect(gateReads.count).toBe(readsBefore); // not read again
    expect(q('[data-testid="panel-state"]')).not.toBeNull();
    expect(evidenceBox()!.checked).toBe(true);
    expect(tasksTab()!.getAttribute('aria-selected')).toBe('true');
    expect(reason()!.value).toBe('배포 근거 확인함');
  });
});

describe('[SID:4456] the sheet keeps its focus handling (PO 07:18Z)', () => {
  it('focus moves into the sheet when a row opens it · Esc closes it · focus goes back to that row', async () => {
    mobileRef.current = true;
    searchRef.current = '';
    await render();
    const row = q('[role="button"][aria-pressed]')!;
    await act(async () => { row.focus(); row.click(); });
    expect(replaceMock).toHaveBeenCalledWith('/work-list?row=t1');
    searchRef.current = 'row=t1'; await render();
    const sheet = q('[data-slot="sheet-content"]')!;
    expect(sheet.querySelector('[data-testid="panel-assignee"]')).not.toBeNull();
    expect(sheet.contains(document.activeElement)).toBe(true); // focus trapped inside the sheet
    await act(async () => { sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(replaceMock).toHaveBeenLastCalledWith('/work-list');
    searchRef.current = ''; await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(q('[data-slot="sheet-content"]')).toBeNull();
    expect(document.activeElement).toBe(q('[role="button"][aria-pressed]'));
  });
});
