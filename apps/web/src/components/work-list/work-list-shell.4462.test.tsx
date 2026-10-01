// @vitest-environment jsdom
//
// [SID:4462] ⓐ (Kadir 09:14Z · from 4878) The sheet stays mounted while it plays its closing transition. Crossing the width back
// during it: the aside gave the panel's host node back and the sheet's slot — already mounted — never adopted it again, so the
// sheet opened empty. jsdom plays no transitions; the sheet here keeps its content mounted while closed, as during one.
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
vi.mock('@/components/ui/sheet', () => ({
  // closed = its content stays mounted (as while the closing transition plays)
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => <div data-sheet-open={String(open)}>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div data-slot="sheet-content">{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
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

describe('[SID:4462] ⓐ crossing the width back while the sheet is still closing', () => {
  it('sheet → aside (the sheet still mounted, closing) → sheet again: the panel is in the sheet, not nowhere', async () => {
    mobileRef.current = true; await render();
    const panelNode = q('[data-testid="panel-assignee"]');
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode);
    mobileRef.current = false; await render(); // to the aside — the sheet keeps its content mounted (closing)
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode);
    mobileRef.current = true; await render(); // back before the sheet finished closing
    expect(q('[data-slot="sheet-content"] [data-testid="panel-assignee"]')).toBe(panelNode); // not an empty sheet
    expect(panelNode!.isConnected).toBe(true);
  });

  it('and the other way: aside → sheet → aside keeps the panel in the aside', async () => {
    await render();
    const panelNode = q('[data-testid="panel-assignee"]');
    mobileRef.current = true; await render();
    mobileRef.current = false; await render();
    expect(q('aside[data-work-list-detail] [data-testid="panel-assignee"]')).toBe(panelNode);
  });
});
