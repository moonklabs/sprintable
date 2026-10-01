// @vitest-environment jsdom
//
// [SID:4462] (Kadir 09:14Z · PR 4878 second line) The detail panel is not mounted again per work item, so its gate state belonged to
// no one: an approve / 409 flow started on work item A that ended after the person moved to B put A's gate into B's panel (and its
// «approved»), and B's first render still drew A's gate — a person on B could press A's gate. Every piece of the gate flow now carries
// the work item it was read for; a result for another work item is dropped, and a press acts only on the current work item's gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { WorkListDetailPanel } from './work-list-detail-panel';
import type { WorkListRow } from './derive-work-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/verify/evidence-section', () => ({ EvidenceSection: () => null }));
vi.mock('@/components/canvas/artifact-section', () => ({ ArtifactSection: () => null }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human', orgId: 'org-1' }), useConnectRulesHref: (p: string) => p }));

// every render of the high-risk sign flow, with the gate it was handed and the row on screen then
const { signRenders, screenRow } = vi.hoisted(() => ({ signRenders: [] as { gateId: string; rowId: string }[], screenRow: { current: '' } }));
vi.mock('@/components/cage/gate-signature-approval', () => ({
  GateSignatureApproval: (props: { gate: { id: string } }) => {
    signRenders.push({ gateId: props.gate.id, rowId: screenRow.current });
    return <div data-testid="stub-sign" data-gate-id={props.gate.id} />;
  },
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

const gateA = { id: 'gA', gate_type: 'qa', risk_grade: 'low', status: 'pending', work_item_id: 'task-A', work_item_type: 'task' };
const gateB = { id: 'gB', gate_type: 'qa', risk_grade: 'low', status: 'pending', work_item_id: 'task-B', work_item_type: 'task' };
const rowA: WorkListRow = { id: 'row-A', kind: 'task', workItemType: 'task', workItemId: 'task-A', title: '일 A', ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: 'awaiting_approval' };
const rowB: WorkListRow = { ...rowA, id: 'row-B', workItemId: 'task-B', title: '일 B' };

type Held = { resolve: (r: unknown) => void };
const held: Record<string, Held[]> = {};
const posts: string[] = [];
let holdB = false;
let holdTransition = false;
let gatesFor: Record<string, unknown> = { 'task-A': gateA, 'task-B': gateB };

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
const bare = (items: unknown) => ({ ok: true, status: 200, json: async () => items });
function hold(key: string): Promise<unknown> {
  return new Promise((resolve) => { (held[key] ??= []).push({ resolve }); });
}

beforeEach(() => {
  signRenders.length = 0;
  posts.length = 0;
  holdB = false;
  holdTransition = false;
  gatesFor = { 'task-A': gateA, 'task-B': gateB };
  for (const k of Object.keys(held)) delete held[k];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u.includes('/transition')) {
      posts.push(u);
      if (holdTransition) return hold('transition');
      return ok({ status: 'approved' });
    }
    if (u.startsWith('/api/gates')) {
      const id = new URL(u, 'http://x').searchParams.get('work_item_id') ?? '';
      if (id === 'task-B' && holdB) return hold('gates-B');
      const g = gatesFor[id];
      return bare(g ? [g] : []);
    }
    if (u.startsWith('/api/activity-logs')) return ok({ items: [] });
    return ok([]);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

let container: HTMLDivElement;
let root: Root;

async function show(row: WorkListRow, storyId: string) {
  screenRow.current = row.id;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <WorkListDetailPanel row={row} storyId={storyId} storyTitle="스토리" goalTitle="목표" onClose={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const approveButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('승인'));

describe('[SID:4462] the detail panel\'s gate belongs to the work item it was read for', () => {
  it('A\'s approve still running when the person moves to B: when it ends, B keeps B\'s gate and its button — a press approves B, never A', async () => {
    await show(rowA, 'story-A');
    expect(approveButton()).toBeTruthy();
    holdTransition = true;
    await act(async () => { approveButton()!.click(); });
    expect(posts).toEqual(['/api/gates/gA/transition']);

    await show(rowB, 'story-B'); // B's own gate is read and shown
    expect(approveButton()).toBeTruthy();

    holdTransition = false;
    await act(async () => { held.transition!.shift()!.resolve(ok({ status: 'approved' })); });
    await settle(); // A's flow ends: «approved» and a fresh read of A's gate — neither is B's

    expect(approveButton()).toBeTruthy(); // not hidden by A's «approved»
    await act(async () => { approveButton()!.click(); });
    await settle();
    expect(posts.at(-1)).toBe('/api/gates/gB/transition');
  });

  it('A\'s 409 (draft changed) ends after the move to B: no error line and no A gate on B', async () => {
    await show(rowA, 'story-A');
    holdTransition = true;
    await act(async () => { approveButton()!.click(); });
    await show(rowB, 'story-B');
    await act(async () => { held.transition!.shift()!.resolve({ ok: false, status: 409, json: async () => ({ error: { code: 'gate_draft_changed' } }) }); });
    await settle();
    expect(container.textContent).not.toContain(koMessages.cage.gateDraftChangedError);
    await act(async () => { approveButton()!.click(); });
    await settle();
    expect(posts.at(-1)).toBe('/api/gates/gB/transition');
  });

  // Kadir 4882 (PO 11:44Z): the AC «a press acts only on the current work item's gate» had no test that reached it — every test
  // pressed B's fresh button. Here A's own click handler (held from A's render, as an event already in flight would) is called
  // after the panel moved to B: no request, no change on B.
  it('A\'s approve handler, held from A\'s render and called after the move to B, does nothing — no request · no state on B', async () => {
    await show(rowA, 'story-A');
    const btn = approveButton()!;
    const propsKey = Object.keys(btn).find((k) => k.startsWith('__reactProps'))!;
    const heldClick = (btn as unknown as Record<string, { onClick: (e: unknown) => void }>)[propsKey].onClick; // A's handler
    holdB = true; // B's gate still being read: nothing of A may act meanwhile
    await show(rowB, 'story-B');
    const postsBefore = posts.length;
    await act(async () => { heldClick({ preventDefault() {}, stopPropagation() {} }); });
    await settle();
    expect(posts.length).toBe(postsBefore); // no transition sent for A's gate from B's screen
    expect(container.querySelector('[data-testid="panel-approved-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-transition-error"]')).toBeNull();
  });

  it('the first render on another work item draws nothing of the previous one\'s gate (B\'s still being read)', async () => {
    gatesFor = { 'task-A': { ...gateA, risk_grade: 'high' }, 'task-B': { ...gateB, risk_grade: 'high' } };
    await show(rowA, 'story-A');
    expect(signRenders.some((r) => r.gateId === 'gA')).toBe(true); // A's sign flow was drawn on A
    holdB = true;
    signRenders.length = 0;
    await show(rowB, 'story-B');
    expect(signRenders.filter((r) => r.rowId === 'row-B')).toEqual([]); // not even one render of A's gate on B
    expect(container.querySelector('[data-testid="stub-sign"]')).toBeNull();
  });
});
