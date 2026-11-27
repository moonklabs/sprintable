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
