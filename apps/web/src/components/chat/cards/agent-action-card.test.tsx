// @vitest-environment jsdom
//
// story 5041 — the card of an agent's ask, with the viewer's own read and presses stubbed at fetch. Red when: a press is sent without a press, or twice for one press · an irreversible ask is approved
// without asking once more · a refused press (403) is drawn as done and the buttons go away (the ask must stay open for the next person) · a second person opening a decided ask still sees buttons ·
// «changed meanwhile» is drawn like a plain failure · an unknown shape from the server is drawn as a card · the card is a card of the closed vocabulary only (kind + request id).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ChatCard } from './card-catalog';
import { parseAgentAction } from './agent-action-access';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const REQ = '5c1f0a52-3b7e-4e0d-9a6f-1d2c3b4a5e6f';
let container: HTMLDivElement;
let root: Root;
let log: { method: string; url: string; body?: unknown }[];
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (over: Record<string, unknown> = {}) => ({
  id: REQ, state: 'pending', action_key: 'sprint.close', title: '스프린트 「S1」 닫기', prompt: '닫으면 되돌릴 수 없어요', reversible: 'no',
  requested_by: { id: 'a1', name: '오르테가' }, decided_by: null, execution: null, ...over,
});

interface World { read?: () => Response; decision?: (body: { decision: string }) => Response }
function stub(w: World = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    log.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'GET' && url === `/api/agent-actions/${REQ}`) return (w.read ? w.read() : json(200, view())).clone();
    if (method === 'POST' && url === `/api/agent-actions/${REQ}/decision`) return (w.decision ? w.decision(JSON.parse(String(init!.body))) : json(200, view({ state: 'executed', decided_by: { id: 'p1', name: '윤재' } }))).clone();
    return json(404);
  }));
}
async function show(card: unknown = { kind: 'agent_action', ref: REQ }) {
  await act(async () => { root.render(null); });
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatCard card={card} /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const writes = () => log.filter((c) => c.method !== 'GET');
async function press(label: string) { await act(async () => { btn(label)!.click(); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); log = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('«늘 허용» (story 5041 ②)', () => {
  it('is not offered unless the server says so — no button, whatever the ask is', async () => {
    stub(); await show();
    expect(btn('이 에이전트는 이 프로젝트에서 늘 허용')).toBeUndefined();
  });
  it('is offered when the server says so; it asks once, says what it means, and sends ONE decision with always_allow — cancelling sends nothing', async () => {
    stub({ read: () => json(200, view({ always_allow_available: true })) }); await show();
    expect(btn('이 에이전트는 이 프로젝트에서 늘 허용')).toBeTruthy();
    await press('이 에이전트는 이 프로젝트에서 늘 허용');
    expect(container.textContent).toContain('묻지 않고 에이전트 자신의 권한으로 바로 해요');
    expect(container.textContent).toContain('다른 프로젝트나 다른 에이전트에는 그대로 물어요');
    expect(writes()).toEqual([]);
    await press('취소');
    expect(writes()).toEqual([]);
    expect(btn('승인하기')).toBeTruthy();
    await press('이 에이전트는 이 프로젝트에서 늘 허용'); await press('승인하고 늘 허용');
    expect(writes()).toEqual([{ method: 'POST', url: `/api/agent-actions/${REQ}/decision`, body: { decision: 'approve', always_allow: true } }]);
  });
  it('a plain approval never carries always_allow', async () => {
    stub({ read: () => json(200, view({ always_allow_available: true })) }); await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(writes()).toEqual([{ method: 'POST', url: `/api/agent-actions/${REQ}/decision`, body: { decision: 'approve' } }]);
  });
  it('parseAgentAction reads only a literal true as «offered»', () => {
    const base = { id: REQ, state: 'pending', title: 't', prompt: 'p', reversible: 'no' };
    expect(parseAgentAction({ ...base, always_allow_available: true })?.alwaysAllowAvailable).toBe(true);
    for (const v of [false, 'true', 1, null, undefined]) expect(parseAgentAction({ ...base, always_allow_available: v })?.alwaysAllowAvailable).toBe(false);
  });
});

describe('an open ask', () => {
  it('shows the ask, who asked, the two buttons — and mounting alone sends NO write', async () => {
    stub(); await show();
    expect(container.textContent).toContain('스프린트 「S1」 닫기');
    expect(container.textContent).toContain('오르테가님이 요청했어요');
    expect(btn('승인하기')).toBeTruthy(); expect(btn('거절하기')).toBeTruthy();
    expect(writes()).toEqual([]);
  });
  it('an irreversible ask asks once more before it sends anything; cancelling sends nothing', async () => {
    stub(); await show();
    await press('승인하기');
    expect(container.textContent).toContain('되돌릴 수 없는 일이에요');
    expect(writes()).toEqual([]);
    await press('취소');
    expect(writes()).toEqual([]);
    expect(btn('승인하기')).toBeTruthy();
  });
  it('approving after the second ask sends exactly ONE decision call and then shows who did it', async () => {
    stub(); await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(writes()).toEqual([{ method: 'POST', url: `/api/agent-actions/${REQ}/decision`, body: { decision: 'approve' } }]);
    expect(container.textContent).toContain('윤재님이 승인해서 처리했어요');
    expect(btn('승인하기')).toBeUndefined();
  });
  it('a reversible ask is approved at once (no second question)', async () => {
    stub({ read: () => json(200, view({ reversible: 'yes' })) }); await show();
    await press('승인하기');
    expect(writes()).toHaveLength(1);
  });
  it('declining sends the decline and shows who declined', async () => {
    stub({ decision: () => json(200, view({ state: 'rejected', decided_by: { id: 'p1', name: '윤재' } })) }); await show();
    await press('거절하기');
    expect(writes()).toEqual([{ method: 'POST', url: `/api/agent-actions/${REQ}/decision`, body: { decision: 'reject' } }]);
    expect(container.textContent).toContain('윤재님이 거절했어요');
  });
  it('a person who may not do it (403) gets one plain line and the buttons STAY — the ask is open for the next person', async () => {
    stub({ decision: () => json(403, { error: { code: 'AGENT_ACTION_FORBIDDEN_FOR_APPROVER' } }) }); await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(container.textContent).toContain('내 권한으로는 할 수 없어요');
    expect(container.textContent).not.toContain('처리했어요');
    expect(btn('승인하기')).toBeTruthy(); expect(btn('거절하기')).toBeTruthy();
  });
  it.each([404, 410, 422])('a press answered %i (gone / changed): the card re-reads instead of repeating the press', async (status) => {
    let reads = 0;
    stub({ read: () => (reads++ === 0 ? json(200, view()) : json(200, view({ state: 'failed', execution: { state: 'failed', http_status: 409, reason: 'x' } }))), decision: () => json(status) });
    await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(reads).toBe(2);
    expect(container.textContent).toContain('그새 상태가 바뀌어서 실행하지 않았어요');
    expect(btn('승인하기')).toBeUndefined();
  });
  it('a fault (500) says it could not be done and keeps the buttons', async () => {
    stub({ decision: () => json(500) }); await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(container.textContent).toContain('잠시 뒤 다시 눌러 주세요');
    expect(btn('승인하기')).toBeTruthy();
  });
  it('someone else decided first (409): the card re-reads and shows THEIR outcome, not buttons', async () => {
    let reads = 0;
    stub({
      read: () => (reads++ === 0 ? json(200, view()) : json(200, view({ state: 'executed', decided_by: { id: 'p2', name: '도선' } }))),
      decision: () => json(409, { error: { code: 'AGENT_ACTION_ALREADY_DECIDED' } }),
    });
    await show();
    await press('승인하기'); await press('승인해서 실행');
    expect(container.textContent).toContain('도선님이 승인해서 처리했어요');
    expect(btn('승인하기')).toBeUndefined();
  });
});

describe('the object the ask is about (story 5041 follow-up)', () => {
  const STORY = '0d6e953f-6d43-42c1-a87c-b023544497db';
  const withTarget = (over: Record<string, unknown> = {}) => view({ action_key: 'story.delete', target: { kind: 'story', id: STORY }, ...over });
  const storyStub = (read: () => Response) => stub({ read });

  it('an open ask shows the object it is about as the object\'s own card (read for the viewer) — and nothing is sent', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === `/api/agent-actions/${REQ}`) return json(200, withTarget());
      if (url.includes(`/api/stories/${STORY}`)) return json(200, { data: { id: STORY, title: '일회용 스토리', status: 'backlog' } });
      return json(404);
    }));
    await show();
    expect(container.querySelector('[data-testid="chat-card-agent-action"]')).toBeTruthy();
    expect(seen.some((u) => u.includes(`/api/stories/${STORY}`))).toBe(true);
    expect(writes()).toEqual([]);
    expect(container.querySelector('[data-testid="agent-action-gone"]')).toBeNull();
  });

  it('⭐after a delete is done there is nothing to open: «지워졌어요», no object card, no read of the object', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === `/api/agent-actions/${REQ}`) return json(200, withTarget({ state: 'executed', decided_by: { id: 'p1', name: '윤재' } }));
      return json(404);
    }));
    await show();
    expect(container.querySelector('[data-testid="agent-action-gone"]')?.textContent).toBe('지워졌어요');
    expect(container.querySelector('[data-testid="chat-card-story"]')).toBeNull();
    expect(seen.some((u) => u.includes('/api/stories/'))).toBe(false);
  });

  it('a close (not a delete) keeps the object: executed, and the sprint is still there to open', async () => {
    storyStub(() => json(200, view({ action_key: 'sprint.close', state: 'executed', target: { kind: 'sprint', id: STORY } })));
    await show();
    expect(container.querySelector('[data-testid="agent-action-gone"]')).toBeNull();
  });

  it('a grant has no object: no object card, no «지워졌어요»', async () => {
    storyStub(() => json(200, view({ action_key: 'reward.give', target: null })));
    await show();
    expect(container.querySelector('[data-testid="agent-action-gone"]')).toBeNull();
    expect(container.querySelector('[data-testid^="chat-card-story"]')).toBeNull();
  });

  it('a target of a kind the web cannot draw is ignored, not drawn as a guess', async () => {
    storyStub(() => json(200, view({ action_key: 'story.delete', target: { kind: 'weird', id: STORY } })));
    await show();
    expect(container.querySelector('[data-testid="chat-card-agent-action"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-action-gone"]')).toBeNull();
  });
});

describe('a press that did not finish', () => {
  it('shows «끝나지 않았어요», says pressing again continues it, and keeps the buttons', async () => {
    stub({ read: () => json(200, view({ state: 'retry', execution: { state: 'failed', reason: 'unfinished' } })) }); await show();
    expect(container.textContent).toContain('끝나지 않았어요');
    expect(container.textContent).toContain('같은 요청은 두 번 처리되지 않아요');
    expect(btn('승인하기')).toBeTruthy(); expect(btn('거절하기')).toBeTruthy();
    expect(container.textContent).not.toContain('24시간 뒤에 거절돼요');
    expect(writes()).toEqual([]);
  });
});

describe('a settled ask (a second person opens it later)', () => {
  it.each([
    ['rejected', { state: 'rejected', decided_by: { id: 'p1', name: '윤재' } }, '윤재님이 거절했어요'],
    ['expired', { state: 'expired' }, '24시간 안에 누르지 않아 거절됐어요'],
    ['failed', { state: 'failed', execution: { state: 'failed', http_status: 500, reason: 'x' } }, '처리하지 못했어요. 에이전트가 이유를 전해 줄 거예요'],
    ['changed meanwhile', { state: 'failed', execution: { state: 'failed', http_status: 409, reason: 'x' } }, '그새 상태가 바뀌어서 실행하지 않았어요'],
  ])('%s: the outcome line, no buttons, no write', async (_n, over, line) => {
    stub({ read: () => json(200, view(over)) }); await show();
    expect(container.textContent).toContain(line);
    expect(container.querySelector('button')).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe('reads that are not a card', () => {
  it('404 / 403 = the plain «찾을 수 없어요» (a request in a project the viewer cannot see looks like one that is not there)', async () => {
    stub({ read: () => json(404) }); await show();
    expect(container.querySelector('[data-card-state="hidden"]')).toBeTruthy();
  });
  it('a body that is not an ask is an error with «try again», never a guessed card', async () => {
    stub({ read: () => json(200, { hello: 'world' }) }); await show();
    expect(container.querySelector('[data-card-state="error"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="chat-card-agent-action"] button')).toBeTruthy(); // the retry
  });
  it('the card is two words: a request id that is not a UUID is the «cannot draw» card', async () => {
    stub(); await show({ kind: 'agent_action', ref: '../x' });
    expect(container.querySelector('[data-testid="chat-card-unknown"]')).toBeTruthy();
    expect(log).toEqual([]);
  });
});

describe('«화면 열기» (story 5041 B6)', () => {
  const screenView = (over: Record<string, unknown> = {}) => view({ action_key: 'screen.channel_connections', title: '채널 연결은 화면에서 직접 해요', prompt: '이 일은 사람이 화면에서 직접 해야 해요.', screen: { key: 'channel_connections', href: '/organization/channels' }, target: null, ...over });
  it('is a link to the screen and a way to close — no approve, no «늘 허용», no 24-hour hint; closing sends ONE reject', async () => {
    stub({ read: () => json(200, screenView({ always_allow_available: true })) }); await show();
    const link = container.querySelector('[data-testid="agent-action-open-screen"]') as HTMLAnchorElement;
    expect(link.textContent).toBe('화면 열기');
    expect(link.getAttribute('href')).toBe('/organization/channels');
    expect(btn('승인하기')).toBeUndefined();
    expect(btn('이 에이전트는 이 프로젝트에서 늘 허용')).toBeUndefined();
    expect(container.textContent).not.toContain('24시간');
    expect(writes()).toEqual([]);
    await press('닫기');
    expect(writes()).toEqual([{ method: 'POST', url: `/api/agent-actions/${REQ}/decision`, body: { decision: 'reject' } }]);
  });
  it('a closed screen card has no button to the screen', async () => {
    stub({ read: () => json(200, screenView({ state: 'rejected', decided_by: { id: 'p', name: '민' } })) }); await show();
    expect(container.querySelector('[data-testid="agent-action-open-screen"]')).toBeNull();
    expect(btn('닫기')).toBeUndefined();
  });
  it('parseAgentAction takes only an app-internal path — never another site, a scheme or a protocol-relative link', () => {
    const base = { id: REQ, state: 'pending', title: 't', prompt: 'p', reversible: 'no' };
    expect(parseAgentAction({ ...base, screen: { key: 'k', href: '/organization/channels' } })?.screen).toEqual({ key: 'k', href: '/organization/channels' });
    for (const href of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', 'organization/channels', '/Organization', '/', 5, null]) {
      expect(parseAgentAction({ ...base, screen: { key: 'k', href } })?.screen).toBeNull();
    }
    expect(parseAgentAction({ ...base })?.screen).toBeNull();
  });
});

describe('parseAgentAction', () => {
  it('rejects an unknown state and a missing title', () => {
    expect(parseAgentAction(view({ state: 'weird' }))).toBeNull();
    expect(parseAgentAction({ ...view(), title: undefined })).toBeNull();
    expect(parseAgentAction(null)).toBeNull();
  });
  it('reversible = no is the only thing that asks twice', () => {
    expect(parseAgentAction(view({ reversible: 'no' }))!.irreversible).toBe(true);
    expect(parseAgentAction(view({ reversible: 'partly' }))!.irreversible).toBe(false);
    expect(parseAgentAction(view({ reversible: 'yes' }))!.irreversible).toBe(false);
  });
});
