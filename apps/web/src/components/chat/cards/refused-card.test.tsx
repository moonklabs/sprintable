// @vitest-environment jsdom
//
// story 5034 (C4 step 4b) — the REFUSED card, drawn for each viewer by THEIR rights (their own session stubbed at fetch). Red when: a viewer who cannot read the object is told anything but «찾을 수 없어요» (an agent was
// refused · who can see it) · a viewer who can read it is not told the agent could not see the project and who can · the list of who can see it carries anything but names, or inactive agents, or is read when the object is
// not readable · a failing agent-name or list read hides a card the viewer may see · the card is drawn as a refused card without a valid `refused_for` · an ordinary card changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ChatCard } from './card-catalog';
import { parseCardRef } from './card-kinds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectMemberships: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const ID = '0d6e953f-6d43-42c1-a87c-b023544497db';
const AGENT = '1b1b1b1b-2c2c-4d4d-8e8e-3f3f3f3f3f3f';
const PROJECT = 'proj-9';
let container: HTMLDivElement;
let root: Root;
let calls: string[];
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World { object?: Response; agent?: Response; list?: Response }
function stub(w: World = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.startsWith('/api/stories/')) return (w.object ?? json(200, { data: { title: '결제 화면 고치기', status: 'in-progress', project_id: PROJECT } })).clone();
    if (url.startsWith('/api/sprints/')) return (w.object ?? json(200, { data: { name: '11월 스프린트', status: 'active', project_id: PROJECT } })).clone();
    if (url.startsWith(`/api/team-members/${AGENT}`)) return (w.agent ?? json(200, { data: { id: AGENT, type: 'agent', name: '오르테가' } })).clone();
    if (url.startsWith('/api/team-members?')) return (w.list ?? json(200, { data: [
      { id: 'mem-aaaa-0001', type: 'agent', name: '미르코', is_active: true }, { id: 'mem-aaaa-0002', type: 'agent', name: '쉬는 에이전트', is_active: false },
      { id: 'mem-aaaa-0003', type: 'agent', name: '카디르', is_active: true }, { id: 'mem-hhhh-0001', type: 'human', name: '사람', is_active: true },
    ] })).clone();
    return json(404);
  }));
}
async function show(card: unknown) {
  await act(async () => { root.render(null); });
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatCard card={card} /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const refused = (over: object = {}) => ({ kind: 'story', ref: ID, refused_for: AGENT, ...over });

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); calls = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('one refused card, two viewers', () => {
  it('a viewer who CAN read the object sees it, that the agent could not see the project, and who can — active agents by name only', async () => {
    stub(); await show(refused());
    expect(container.querySelector('[data-testid="chat-card-refused"]')).not.toBeNull();
    expect(container.textContent).toContain('결제 화면 고치기');
    expect(container.textContent).toContain('보여 주려던 에이전트: 오르테가');
    expect(container.textContent).toContain('이 프로젝트를 볼 수 없어서');
    const seers = container.querySelector('[data-testid="chat-card-refused-seers"]')!.textContent!;
    expect(seers).toBe('볼 수 있는 에이전트: 미르코 · 카디르'); // inactive agent and the person are not in it
    expect(calls).toContain(`/api/team-members?project_id=${PROJECT}&type=agent`);
    expect(container.innerHTML).not.toMatch(/mem-/); // no member id on the card
  });
  it('a viewer who can NOT read the object (404 or 403) sees «찾을 수 없어요» and NOTHING else — and the agent / the list are never even asked for', async () => {
    const seen: string[] = [];
    for (const object of [json(404), json(403)]) {
      calls = []; stub({ object }); await show(refused());
      seen.push(container.innerHTML);
      expect(container.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('hidden');
      expect(container.textContent).toBe('찾을 수 없어요');
      expect(calls.some((c) => c.includes('team-members'))).toBe(false);
    }
    expect(seen[0]).toBe(seen[1]);
  });
  it('the SAME message draws two different cards for two viewers (the object readable → the refusal story; not readable → «찾을 수 없어요»)', async () => {
    stub(); await show(refused()); const a = container.textContent;
    stub({ object: json(404) }); await show(refused()); const b = container.textContent;
    expect(a).not.toBe(b); expect(b).toBe('찾을 수 없어요'); expect(a).toContain('볼 수 있는 에이전트');
  });
});

describe('what can go wrong around it never hides a card the viewer may see', () => {
  it('the agent\'s own name unreadable → that line is left out · the list unreadable or of another shape → the «no agent» line · the card itself stays', async () => {
    stub({ agent: json(404) }); await show(refused());
    expect(container.textContent).toContain('결제 화면 고치기'); expect(container.textContent).not.toContain('보여 주려던 에이전트');
    stub({ list: json(403) }); await show(refused());
    expect(container.textContent).toContain('결제 화면 고치기'); expect(container.textContent).toContain('볼 수 있는 에이전트가 없어요');
    stub({ list: json(200, { data: 'nope' }) }); await show(refused());
    expect(container.textContent).toContain('볼 수 있는 에이전트가 없어요');
    stub({ list: json(200, { data: [{ type: 'agent', is_active: false, name: 'x' }] }) }); await show(refused());
    expect(container.textContent).toContain('볼 수 있는 에이전트가 없어요');
  });
  it('a network failure (not an answer) reading the agent or the list leaves those lines out too — the card the viewer may see is still drawn', async () => {
    stub();
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/team-members')) throw new TypeError('network down');
      return answer(input, init);
    }));
    await show(refused());
    expect(container.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('ready');
    expect(container.textContent).toContain('결제 화면 고치기'); expect(container.textContent).not.toContain('보여 주려던 에이전트');
    expect(container.textContent).toContain('볼 수 있는 에이전트가 없어요');
  });
  it('a server fault reading the object is «error» with «다시 시도» (a viewer may be able to read it)', async () => {
    stub({ object: json(503) }); await show(refused());
    expect(container.querySelector('[data-card-state]')!.getAttribute('data-card-state')).toBe('error');
  });
  it('a long list is cut at eight names with «…»', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ type: 'agent', is_active: true, name: `에이전트${i}` }));
    stub({ list: json(200, { data: rows }) }); await show(refused());
    const seers = container.querySelector('[data-testid="chat-card-refused-seers"]')!.textContent!;
    expect(seers).toContain('에이전트7'); expect(seers).not.toContain('에이전트8'); expect(seers.endsWith(' …')).toBe(true);
  });
});

describe('which cards are refused cards', () => {
  it('a sprint board is refused like any entity (its sprint is read) · a kind the tool cannot post (gate · deploy) with `refused_for` is the «cannot show» card · a bad `refused_for` is not a card', async () => {
    stub(); await show(refused({ kind: 'kanban' }));
    expect(container.textContent).toContain('11월 스프린트'); expect(container.querySelector('[data-testid="chat-card-refused"]')).not.toBeNull();
    stub(); await show(refused({ kind: 'deploy' }));
    expect(container.querySelector('[data-testid="chat-card-unknown"]')).not.toBeNull();
    for (const bad of ['nope', 7, [], `{${AGENT}}`]) { await show(refused({ refused_for: bad })); expect(container.querySelector('[data-testid="chat-card-unknown"]'), String(bad)).not.toBeNull(); }
  });
  it('parseCardRef: refused_for is read only as a plain UUID; absent or null is an ordinary card; the ordinary card is unchanged', () => {
    expect(parseCardRef({ kind: 'story', ref: ID })).toEqual({ kind: 'story', ref: ID });
    expect(parseCardRef({ kind: 'story', ref: ID, refused_for: null })).toEqual({ kind: 'story', ref: ID });
    expect(parseCardRef({ kind: 'story', ref: ID, refused_for: AGENT })).toEqual({ kind: 'story', ref: ID, refusedFor: AGENT });
    expect(parseCardRef({ kind: 'story', ref: ID, refused_for: 'x' })).toBeNull();
    expect(parseCardRef({ kind: 'story', ref: ID, html: '<b>' })).toEqual({ kind: 'story', ref: ID });
  });
});
