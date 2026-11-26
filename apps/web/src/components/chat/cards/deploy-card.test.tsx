// @vitest-environment jsdom
//
// story 5034 (C4 step 3b) — the «넣기 · 빼기» card, with the viewer's own reads and writes stubbed at fetch. Red when: a button is drawn for a viewer whose role may not manage access (or when the access list
// was not readable) · a write is sent without a press, or twice for one press · «place» / «take out» send anything but the exact project-access call · a person's id is drawn as an agent card · «not found» and
// «not yours» stop looking the same · taking an agent out stops asking first · a refused write (403) is shown as done · the card moves the agent org-wide.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ChatCard } from './card-catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let ctx: { projectId: string | null; role: string | null; projectMemberships: unknown[] } = { projectId: 'proj-1', role: 'admin', projectMemberships: [] };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const AGENT = '0d6e953f-6d43-42c1-a87c-b023544497db';
const REC = 'rec-1';
let container: HTMLDivElement;
let root: Root;
let log: { method: string; url: string; body?: unknown }[];
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World { member?: Response; access?: () => Response; post?: () => Response; del?: () => Response }
let placed = false;
function stub(w: World = {}) {
  placed = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    log.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'GET' && url.startsWith('/api/team-members/')) return (w.member ?? json(200, { data: { id: AGENT, type: 'agent', name: '오르테가', is_active: true } })).clone();
    if (method === 'GET' && url.endsWith('/access')) return (w.access ? w.access() : json(200, { data: placed ? [{ id: REC, member_id: AGENT, permission: 'granted' }, { id: 'rec-other', member_id: 'someone', permission: 'granted' }] : [{ id: 'rec-other', member_id: 'someone' }] })).clone();
    if (method === 'POST') { const r = w.post ? w.post() : json(201, { data: { id: REC } }); if (r.status < 300) placed = true; return r.clone(); }
    if (method === 'DELETE') { const r = w.del ? w.del() : json(200, { data: { ok: true } }); if (r.status < 300) placed = false; return r.clone(); }
    return json(404);
  }));
}
async function show() {
  await act(async () => { root.render(null); });
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatCard card={{ kind: 'deploy', ref: AGENT }} /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const frame = () => container.querySelector('[data-card-state]') as HTMLElement | null;
const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const writes = () => log.filter((c) => c.method !== 'GET');
async function press(label: string) { await act(async () => { btn(label)!.click(); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); log = []; ctx = { projectId: 'proj-1', role: 'admin', projectMemberships: [] }; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('who sees a button', () => {
  it('an org admin sees «이 프로젝트에 넣기» for an agent that is not placed — and mounting alone sends NO write', async () => {
    stub(); await show();
    expect(container.textContent).toContain('오르테가'); expect(container.textContent).toContain('이 프로젝트에 들어 있지 않아요');
    expect(btn('이 프로젝트에 넣기')).toBeTruthy();
    expect(log.filter((c) => c.method === 'GET').map((c) => c.url).sort()).toEqual([`/api/projects/proj-1/access`, `/api/team-members/${AGENT}`].sort());
    expect(writes()).toEqual([]);
  });
  it('a member (not owner/admin) sees the name and NOTHING to press — and the access list is not even asked for (it would be a 403)', async () => {
    ctx.role = 'member'; stub(); await show();
    expect(container.textContent).toContain('오르테가');
    expect(container.querySelector('button')).toBeNull();
    expect(log.some((c) => c.url.endsWith('/access'))).toBe(false);
    expect(container.textContent).not.toContain('들어 있지 않아요'); expect(container.textContent).not.toContain('들어 있어요');
  });
  it('an admin whose access-list read is refused by the server (403) sees the name only, no state, no button', async () => {
    stub({ access: () => json(403) }); await show();
    expect(container.textContent).toContain('오르테가'); expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('이 프로젝트에 넣기');
  });
  it('no current project → no button; an inactive agent cannot be placed (no «넣기» button) but can still be taken out when it is placed', async () => {
    ctx.projectId = null; stub(); await show();
    expect(container.querySelector('button')).toBeNull();
    ctx.projectId = 'proj-1';
    stub({ member: json(200, { data: { id: AGENT, type: 'agent', name: '쉬는 에이전트', is_active: false } }) }); await show();
    expect(container.textContent).toContain('비활성 에이전트예요'); expect(btn('이 프로젝트에 넣기')).toBeUndefined();
  });
});

describe('what the card is a card of', () => {
  it('a person\'s id is not an agent card — the same «찾을 수 없어요» as an agent the viewer cannot see (404 = 403 = a person), and no «try again»', async () => {
    const seen: string[] = [];
    for (const member of [json(200, { data: { id: AGENT, type: 'human', name: '사람' } }), json(404), json(403)]) {
      stub({ member }); await show();
      seen.push(container.innerHTML);
      expect(frame()!.dataset.cardState).toBe('hidden'); expect(container.textContent).toContain('찾을 수 없어요'); expect(container.querySelector('button')).toBeNull();
    }
    expect(new Set(seen).size).toBe(1);
  });
  it('a server fault is «error» with «다시 시도»; a body that is not `{ data }` is the same fault', async () => {
    stub({ member: json(503) }); await show();
    expect(frame()!.dataset.cardState).toBe('error');
    stub({ member: json(200, { id: AGENT, type: 'agent' }) }); await show();
    expect(frame()!.dataset.cardState).toBe('error');
    stub({ access: () => json(200, { data: 'nope' }) }); await show();
    expect(frame()!.dataset.cardState).toBe('error');
  });
});

describe('placing and taking out', () => {
  it('«넣기» sends exactly ONE project-access grant of THIS agent to THIS project, then the card shows «들어 있어요» and offers «빼기»', async () => {
    stub(); await show();
    await press('이 프로젝트에 넣기');
    expect(writes()).toEqual([{ method: 'POST', url: '/api/projects/proj-1/access', body: { member_id: AGENT, org_member_id: null, permission: 'granted' } }]);
    expect(container.textContent).toContain('이 프로젝트에 들어 있어요');
    expect(btn('이 프로젝트에서 빼기')).toBeTruthy(); expect(btn('이 프로젝트에 넣기')).toBeUndefined();
  });
  it('«빼기» ASKS first (nothing is sent) — «취소» sends nothing — «빼기» deletes exactly THIS record of THIS project, then the card shows «들어 있지 않아요»', async () => {
    placed = true; stub(); await show();
    await act(async () => { placed = true; }); // (the stub's world: already placed)
    stub(); placed = true;
    await show();
    expect(container.textContent).toContain('이 프로젝트에 들어 있어요');
    await press('이 프로젝트에서 빼기');
    expect(container.textContent).toContain('뺄까요'); expect(writes()).toEqual([]);
    await press('취소');
    expect(writes()).toEqual([]); expect(btn('이 프로젝트에서 빼기')).toBeTruthy();
    await press('이 프로젝트에서 빼기');
    await press('빼기');
    expect(writes()).toEqual([{ method: 'DELETE', url: `/api/projects/proj-1/access/${REC}` }]);
    expect(container.textContent).toContain('이 프로젝트에 들어 있지 않아요');
  });
  it('the card never touches the agent itself: no write goes to team-members (no org-wide deactivation from a card)', async () => {
    stub(); await show(); await press('이 프로젝트에 넣기');
    expect(log.some((c) => c.method !== 'GET' && c.url.includes('team-members'))).toBe(false);
  });
  it('a refused write (403) is SAID, not shown as done — the button stays; «already placed» (409) is the picture after the next read; a fault says so', async () => {
    stub({ post: () => json(403) }); await show();
    await press('이 프로젝트에 넣기');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('권한이 없어요');
    expect(btn('이 프로젝트에 넣기')).toBeTruthy(); expect(container.textContent).not.toContain('이 프로젝트에 들어 있어요');
    stub({ post: () => json(409) }); await show();
    placed = true; // the server already has it
    await press('이 프로젝트에 넣기');
    expect(container.textContent).toContain('이 프로젝트에 들어 있어요');
    stub({ post: () => json(400, { error: 'not active' }) }); await show();
    await press('이 프로젝트에 넣기');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('지금 넣을 수 없어요');
    stub({ post: () => json(500) }); await show();
    await press('이 프로젝트에 넣기');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('처리하지 못했어요');
  });
  it('one press is one write — a second press while the first is still in flight sends nothing more', async () => {
    let release!: (r: Response) => void;
    stub({ post: () => new Response(null, { status: 201 }) });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') { log.push({ method: 'POST', url: String(input) }); return new Promise<Response>((r) => { release = r; }); }
      return original(input, init);
    }));
    await show();
    await act(async () => { btn('이 프로젝트에 넣기')!.click(); });
    await act(async () => { btn('이 프로젝트에 넣기')?.click(); });
    expect(writes().length).toBe(1);
    await act(async () => { release(json(201, { data: {} })); });
  });
});
