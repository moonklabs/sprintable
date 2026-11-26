// @vitest-environment jsdom
/**
 * story 5033 (C3) — the board's structure (the areas and their order, the only numbers), the press counts (menu = TWO presses: open it · pick the entry), who gets the hands (a read-only viewer gets none) and what a drop means.
 * A drag is one gesture and its meaning is `resolveDrop` (pure, held below); the real mouse drag is held by the layout spec in a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import enMessages from '../../../../messages/en.json';
import type { AgentStateRow } from '@/lib/agent-state-list';
import { BENCH_ID, ControlBoardView, buildDragAnnouncements, channelDropId, dropPlaceName, resolveDrop, type ControlBoardViewProps } from './control-board';
import { deriveControlBoard, grantKey, type BoardProject } from './derive-control-board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1: BoardProject = { id: 'p1', name: 'Alpha' };
const P2: BoardProject = { id: 'p2', name: 'Beta' };
function stateRow(name: string, over: Partial<AgentStateRow> = {}): AgentStateRow {
  return { agent_id: `id-${name}`, agent_name: name, conversation_id: null, conversation_project_id: null, bound_setup_id: 's', bound_device_name: 'mac', setup_id: 's', device_name: 'mac', state: 'working', activity: 'working', state_at: null, limit: null, first_screen: null, ...over };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const onPlace = vi.fn();
const onTakeOut = vi.fn();
const onDrop = vi.fn();
const onFilter = vi.fn();
beforeEach(() => { onPlace.mockReset(); onTakeOut.mockReset(); onDrop.mockReset(); onFilter.mockReset(); });

async function mount(opts: { grants: Record<string, string> | null; agents: AgentStateRow[]; epics?: Array<{ projectId: string; total: number; done: number }> | null; needsHand?: Record<string, number>; outcome?: ControlBoardViewProps['outcome']; filter?: string | null }) {
  const projects = [P1, P2];
  const filter = opts.filter ?? null;
  const model = deriveControlBoard({ projects, epics: opts.epics === null ? null : (opts.epics ?? []).map((e) => ({ ...e, status: 'active' })), agents: opts.agents, grants: opts.grants, filterProjectId: filter, needsHandByProject: opts.needsHand ?? {} });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ControlBoardView
          model={model} projects={projects} filterProjectId={filter} onFilter={onFilter} outcome={opts.outcome ?? null} onDrop={onDrop}
          actions={{ canWrite: opts.grants !== null, projects, placedIn: (id) => new Set(projects.filter((p) => opts.grants?.[grantKey(id, p.id)] !== undefined).map((p) => p.id)), onPlace, onTakeOut, busyKey: null }}
        />
      </NextIntlClientProvider>,
    );
  });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];

/** one press = one click of the person (pointer down · up · click) — the count the test holds */
let presses = 0;
async function press(el: Element) {
  presses += 1;
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  });
}
beforeEach(() => { presses = 0; });

const GRANTS = { [grantKey('id-Ann', 'p1')]: 'r1' };
const AGENTS = [stateRow('Ann'), stateRow('Cy', { state: 'idle', activity: 'idle' })];

describe('structure: the areas and their order', () => {
  it('⭐filter → channels (one per project, by name) → «열외» lane — in that order, nothing else', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const order = qa('[data-testid="control-filter"], [data-testid="control-channel"], [data-testid="control-bench"]').map((e) => e.getAttribute('data-testid') + (e.getAttribute('data-drop-id') ?? ''));
    expect(order).toEqual(['control-filter', 'control-channelchannel:p1', 'control-channelchannel:p2', 'control-benchbench']);
    expect(qa('[data-testid="control-channel-name"]').map((e) => e.textContent)).toEqual(['Alpha', 'Beta']);
  });
  it('⭐the filter offers the whole org first, then each project; choosing one reports the project id (no page change)', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const select = q('[data-testid="control-filter"] select, select[data-testid="control-filter"]') as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([['', '조직 전체'], ['p1', 'Alpha'], ['p2', 'Beta']]);
    await act(async () => { select.value = 'p2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onFilter).toHaveBeenCalledWith('p2');
  });
  it('⭐the faces stand in their channels and the lane holds the rest; each face says its state in words', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const inChannel = qa('[data-testid="control-channel"] [data-testid="control-face"]').map((e) => [e.getAttribute('data-channel'), e.getAttribute('data-agent-id'), e.getAttribute('data-word')]);
    expect(inChannel).toEqual([['p1', 'id-Ann', 'working']]);
    expect(qa('[data-testid="control-bench"] [data-testid="control-face"]').map((e) => [e.getAttribute('data-agent-id'), e.getAttribute('data-word')])).toEqual([['id-Cy', 'resting']]);
    expect(qa('[data-testid="control-face-state"]').map((e) => e.textContent)).toEqual(['일하는 중', '쉬는 중']);
  });
  it('⭐the only numbers on the board are a channel\'s progress and its «확인 필요» count — no task list, no totals', async () => {
    await mount({ grants: GRANTS, agents: AGENTS, epics: [{ projectId: 'p1', total: 10, done: 4 }], needsHand: { p2: 3 } });
    const progress = qa('[data-testid="control-channel-progress"]').map((e) => e.textContent);
    expect(progress[0]).toContain('4/10');
    expect(progress[1]).toBe('진행 중인 목표가 없어요');
    expect(q('[data-testid="control-channel-needs-hand"]')!.textContent).toBe('확인 필요 3'); // the badge says what its number is (the hidden name) and then the number
    // strip every allowed number; no digit may be left anywhere else on the board
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-testid="control-channel-needs-hand"]').forEach((n) => n.remove());
    expect(/\d/.test(clone.textContent!.replace('4/10', ''))).toBe(false);
    expect(qa('[data-testid="control-channel-needs-hand"]').length).toBe(1); // a project with nothing waiting draws no badge
  });
  it('⭐the words a person reads: lane «빠진 에이전트», a took-out line that says it comes back (the particle follows the name), never «열외» / «배치»', async () => {
    await mount({ grants: GRANTS, agents: AGENTS, outcome: { kind: 'tookOut', agentName: '댄', projectName: 'Beta' } });
    expect(q('[data-testid="control-outcome"]')!.textContent).toBe('댄을 Beta에서 뺐어요. 다시 넣으면 돌아와요.');
    expect(container.textContent).not.toMatch(/열외|배치/);
  });
  it('⭐an unreadable epics read says «진행률을 읽지 못했어요», not «진행 중인 목표가 없어요»', async () => {
    await mount({ grants: GRANTS, agents: AGENTS, epics: null });
    expect(qa('[data-testid="control-channel-progress"]').map((e) => e.textContent)).toEqual(['진행률을 읽지 못했어요', '진행률을 읽지 못했어요']);
  });
  it('a failed or done outcome is said under the board', async () => {
    await mount({ grants: GRANTS, agents: AGENTS, outcome: { kind: 'placeFailed', agentName: 'Ann', projectName: 'Beta' } });
    expect(q('[data-testid="control-outcome"]')!.textContent).toContain('지금 넣을 수 없어요');
    expect(q('[data-testid="control-outcome"] [role="alert"]')).not.toBeNull();
  });
});

describe('press counts (held): the menu is TWO presses, nothing needs a third', () => {
  it('⭐⋯ button → entry = 2 presses → place (the entry names the project, never an already-placed one)', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const ann = q('[data-testid="control-channel"] [data-testid="control-face"] [data-testid="control-face-menu"]')!;
    await press(ann);
    expect(menuItems().map((m) => m.textContent)).toEqual(['Beta에 넣기', 'Alpha에서 빼기']);
    await press(menuItems()[0]!);
    expect(presses).toBe(2);
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(onPlace.mock.calls[0]![0].agentId).toBe('id-Ann');
    expect(onPlace.mock.calls[0]![1]).toEqual(P2);
    expect(onTakeOut).not.toHaveBeenCalled();
  });
  it('⭐⋯ button → «열외» entry = 2 presses → takeOut of THAT channel (no confirm step in between)', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    await press(q('[data-testid="control-channel"] [data-testid="control-face-menu"]')!);
    await press(menuItems().find((m) => m.textContent === 'Alpha에서 빼기')!);
    expect(presses).toBe(2);
    expect(onTakeOut).toHaveBeenCalledTimes(1);
    expect(onTakeOut.mock.calls[0]![0].agentId).toBe('id-Ann');
    expect(onTakeOut.mock.calls[0]![1]).toEqual(P1);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });
  it('⭐right-click → entry = 2 presses and shows the SAME entries as the ⋯ button', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const face = q('[data-testid="control-channel"] [data-testid="control-face"]')!;
    presses += 1;
    await act(async () => { face.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })); });
    const viaRightClick = menuItems().map((m) => m.textContent);
    expect(viaRightClick).toEqual(['Beta에 넣기', 'Alpha에서 빼기']);
    await press(menuItems()[0]!);
    expect(presses).toBe(2);
    expect(onPlace).toHaveBeenCalledTimes(1);
  });
  it('a benched face\'s menu offers a place per project and no «열외» entry', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    await press(q('[data-testid="control-bench"] [data-testid="control-face-menu"]')!);
    expect(menuItems().map((m) => m.textContent)).toEqual(['Alpha에 넣기', 'Beta에 넣기']);
  });
});

describe('who gets the hands', () => {
  it('⭐a viewer who cannot read the placement: faces + states + progress, but no drag handle, no menu, no drop hint', async () => {
    await mount({ grants: null, agents: AGENTS, epics: [{ projectId: 'p1', total: 2, done: 1 }] });
    expect(qa('[data-testid="control-face"]').length).toBe(2);
    expect(qa('[data-testid="control-face-handle"], [data-testid="control-face-menu"]').length).toBe(0);
    expect(q('[data-testid="control-bench"]')!.textContent).not.toContain('끌면');
    expect(q('[data-testid="control-bench"] h3')!.textContent).toBe('에이전트');
    expect(q('[data-testid="control-channel"]')!.textContent).toContain('조직 관리자만 볼 수 있어요');
  });
  it('an org admin gets a handle (drag) and a ⋯ button on every face, and the lane is called «빠진 에이전트»', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    expect(qa('[data-testid="control-face-handle"]').length).toBe(2);
    expect(qa('[data-testid="control-face-menu"]').length).toBe(2);
    expect(q('[data-testid="control-bench"] h3')!.textContent).toBe('빠진 에이전트');
  });
});

describe('what a drop means (one gesture)', () => {
  it('⭐a face from channel X dropped on channel Y = place in Y', () => {
    expect(resolveDrop({ agentId: 'a', projectId: 'p1' }, channelDropId('p2'))).toEqual({ kind: 'place', agentId: 'a', projectId: 'p2' });
  });
  it('⭐a face from the lane dropped on a channel = place', () => {
    expect(resolveDrop({ agentId: 'a', projectId: null }, channelDropId('p2'))).toEqual({ kind: 'place', agentId: 'a', projectId: 'p2' });
  });
  it('⭐a face from channel X dropped on the lane = takeOut of X (only that channel)', () => {
    expect(resolveDrop({ agentId: 'a', projectId: 'p1' }, BENCH_ID)).toEqual({ kind: 'takeOut', agentId: 'a', projectId: 'p1' });
  });
  it('dropped where it already is, or on the lane from the lane, or off any target = nothing', () => {
    expect(resolveDrop({ agentId: 'a', projectId: 'p1' }, channelDropId('p1'))).toBeNull();
    expect(resolveDrop({ agentId: 'a', projectId: null }, BENCH_ID)).toBeNull();
    expect(resolveDrop({ agentId: 'a', projectId: 'p1' }, null)).toBeNull();
    expect(resolveDrop({ agentId: 'a', projectId: 'p1' }, 'something-else')).toBeNull();
  });
});

describe('what a screen reader hears while a face is dragged (names, never ids — found on dev, story 5033 follow-up)', () => {
  const liveText = () => (document.querySelector('[id^="DndLiveRegion"]') as HTMLElement | null)?.textContent ?? '';
  const instructions = () => (document.querySelector('[id^="DndDescribedBy"]') as HTMLElement | null)?.textContent ?? '';

  it('⭐the hidden instructions are the page\'s own words (Korean here), not dnd-kit\'s English default', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    expect(instructions()).toBe(koMessages.orgBriefing.dragInstructions);
    expect(instructions()).not.toMatch(/space bar|draggable item/i);
  });
  it('⭐picking a face up with the keyboard is announced by the agent\'s NAME — no id in the sentence', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const handle = q('[data-testid="control-channel"] [data-testid="control-face-handle"]')!;
    await act(async () => { handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })); });
    expect(liveText()).toBe('Ann · 끌기를 시작했어요.');
    expect(liveText()).not.toMatch(/::|channel:|bench|id-Ann|p1/);
  });
  it('⭐a drop place is named by the lane\'s title or the project\'s NAME — an unknown place, or a bare string that is not «channel:<id>», says nothing (never its id)', () => {
    const byId = new Map([['p2', { id: 'p2', name: 'Beta' }]]);
    expect(dropPlaceName(channelDropId('p2'), byId, '빠진 에이전트')).toBe('Beta');
    expect(dropPlaceName(BENCH_ID, byId, '빠진 에이전트')).toBe('빠진 에이전트');
    expect(dropPlaceName(channelDropId('gone'), byId, '빠진 에이전트')).toBe('');
    expect(dropPlaceName('p2', byId, '빠진 에이전트'), 'an unprefixed id is not a place').toBe('');
  });

  const say = buildDragAnnouncements({
    t: (key, v) => `${key}|${v.name}|${v.target ?? ''}`,
    agentName: (id) => ({ 'id-Ann': 'Ann' }[id] ?? ''),
    placeName: (dropId) => dropPlaceName(dropId, new Map([['p1', P1], ['p2', P2]]), '빠진 에이전트'),
    agentFallback: 'AGENT',
  });
  const fromP1 = { id: 'p1::id-Ann' } as never;
  it('⭐every sentence names the agent and the PLACE by name; the ids never reach a sentence (all moments)', () => {
    expect(say.onDragStart!({ active: fromP1 })).toBe('dragStartAnnounce|Ann|');
    expect(say.onDragOver!({ active: fromP1, over: { id: channelDropId('p2') } } as never)).toBe('dragOverAnnounce|Ann|Beta');
    expect(say.onDragEnd!({ active: fromP1, over: { id: channelDropId('p2') } } as never)).toBe('dragEndAnnounce|Ann|Beta');
    expect(say.onDragEnd!({ active: fromP1, over: { id: BENCH_ID } } as never)).toBe('dragEndAnnounce|Ann|빠진 에이전트');
    expect(say.onDragCancel!({ active: fromP1 } as never)).toBe('dragCancelAnnounce|Ann|');
  });
  it('⭐over nothing (or over something that is not a place) is SAID — it clears the earlier «over Alpha» instead of leaving it', () => {
    expect(say.onDragOver!({ active: fromP1, over: null } as never)).toBe('dragOverNowhereAnnounce|Ann|');
    expect(say.onDragOver!({ active: fromP1, over: { id: 'channel:gone' } } as never)).toBe('dragOverNowhereAnnounce|Ann|');
  });
  it('⭐«dropped» only when the drop changes something: dropped where it already is, nowhere, or on a stale place = «nothing changed»', () => {
    expect(say.onDragEnd!({ active: fromP1, over: { id: channelDropId('p1') } } as never)).toBe('dragEndNowhereAnnounce|Ann|');
    expect(say.onDragEnd!({ active: fromP1, over: null } as never)).toBe('dragEndNowhereAnnounce|Ann|');
    expect(say.onDragEnd!({ active: fromP1, over: { id: 'channel:gone' } } as never)).toBe('dragEndNowhereAnnounce|Ann|');
    expect(say.onDragEnd!({ active: { id: 'bench::id-Ann' } as never, over: { id: BENCH_ID } } as never), 'lane → lane changes nothing').toBe('dragEndNowhereAnnounce|Ann|');
  });
  it('⭐a face that left the board mid-drag is the generic word, never an empty name', () => {
    expect(say.onDragCancel!({ active: { id: 'p1::id-Gone' } } as never)).toBe('dragCancelAnnounce|AGENT|');
    expect(say.onDragStart!({ active: { id: 'garbage' } } as never)).toBe('dragStartAnnounce|AGENT|');
  });
  it('the English sentences read as sentences (same builder, the en words)', async () => {
    const en = enMessages.orgBriefing as Record<string, string>;
    const fill = (tpl: string, v: Record<string, string | undefined>) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
    const sayEn = buildDragAnnouncements({ t: (key, v) => fill(en[key]!, v), agentName: () => 'Ann', placeName: () => 'Beta', agentFallback: en.dragAgentFallback! });
    expect(sayEn.onDragEnd!({ active: fromP1, over: { id: channelDropId('p2') } } as never)).toBe('Ann · dropped on Beta.');
    expect(sayEn.onDragOver!({ active: fromP1, over: null } as never)).toBe('Ann · outside any place.');
    expect(en.dragInstructions).not.toMatch(/draggable item/);
  });
  it('⭐a keyboard pick-up then Escape is announced as cancelled, by name', async () => {
    await mount({ grants: GRANTS, agents: AGENTS });
    const handle = q('[data-testid="control-channel"] [data-testid="control-face-handle"]')!;
    await act(async () => { handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })); });
    expect(liveText()).toBe('Ann · 끌기를 취소했어요.');
    expect(onDrop).not.toHaveBeenCalled();
  });
});
