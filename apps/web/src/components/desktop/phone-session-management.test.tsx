// @vitest-environment jsdom
//
// story #4733 (S4b · copy yuna/4733-phone-clock-copy-1020.md §8 test pins): «세션 관리» in the phone app — the card of a paired computer, the panel, the card after, the
// start, one agent's row, and every line a press can end in. The server (S2, 5172) is not on dev yet, so every answer here is the contract's shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

let dash: { orgId?: string; orgSyncPending?: boolean } = { orgId: 'org-1' };
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dash }));
const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
const { PhoneSessionManagement } = await import('./phone-session-management');
const { openFlows } = await import('@/lib/phone-start');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP = '11111111-2222-4333-8444-555555555555';
const AGENT = '22222222-3333-4444-8555-666666666666';
const AGENT2 = '22222222-3333-4444-8555-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';
const KEYID = 'p-1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface World {
  startable?: unknown; clock?: Response | unknown; post?: Response; poll?: Response; remote?: boolean; reachable?: boolean; supported?: boolean;
  view?: Record<string, unknown> | null; running?: boolean; outs?: unknown[];
}
let world: World;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
const agents = (running: boolean) => [
  { agent_member_id: AGENT, name: '결제 담당 · 윤재의 맥북', can_command: true, projects: [], running },
  { agent_member_id: AGENT2, name: '문서 담당 · 윤재의 맥북', can_command: true, projects: [], running: false },
];
function server() {
  calls = [];
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/remote-devices') return json({ devices: [{ id: KEYID, confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) {
      return json(world.startable ?? { remote_control: world.remote !== false, computers: [{ setup_id: SETUP, device_name: '윤재의 맥북', reachable: world.reachable !== false, agents: agents(world.running !== false) }] });
    }
    if (url.includes('/clock/commands/')) return world.poll ? world.poll.clone() : json({ command_id: CMD, state: 'done', result_code: 'ok' }); // a Response body can be read once: every look gets its own
    if (url.includes('/clock?phone_key_id=')) {
      if (typeof world.clock === 'function') return (world.clock as () => Promise<Response> | Response)();
      if (world.clock instanceof Response) return world.clock.clone();
      return json(world.clock ?? { remote_control: true, reachable: world.reachable !== false, supported: world.supported !== false, view: world.view ?? null });
    }
    if (url.endsWith('/clock') && method === 'POST') return world.post ?? json({ command_id: CMD, state: 'queued' }, 201);
    throw new Error(`unexpected ${method} ${url}`);
  });
}

let container: HTMLDivElement;
let root: Root;
let phoneCall: ReturnType<typeof vi.fn>;
let signAnswer: Record<string, unknown>;

beforeEach(() => {
  dash = { orgId: 'org-1' };
  world = {};
  signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID };
  phoneCall = vi.fn(async (type: string) => (type === 'device.key.info' ? { id: 'k', ok: true, key_number: '482 917' } : signAnswer));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  fetchWithAuth.mockReset();
  server();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function screen({ phone = true, locale = 'ko' as 'ko' | 'en' } = {}) {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages}><PhoneSessionManagement /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await flush();
}
const text = () => container.textContent ?? '';
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); await flush(); };
const press = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); await settle(); };
const posts = () => calls.filter((c) => c.method === 'POST');
const row = (o: Record<string, unknown> = {}) => ({ agent_member_id: AGENT, name: '결제 담당', state: 'ready', missing: [], first_line: '결제 연동을 끝냈어요', idle: false, ...o });
const panel = (rows: unknown[], count: Record<string, number>, extra: Record<string, unknown> = {}) => ({ mode: 'panel', scope: 'computer', opened_from: 'phone', count, rows, outs: [], reported_at: '2026-10-20T01:00:00Z', ...extra });

describe('[4733 S4b] the card', () => {
  it('outside the phone app nothing is drawn and nothing is asked', async () => {
    await screen({ phone: false });
    expect(byId('phone-sessions')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('a computer whose app does not speak `clock` (an older daemon) → NO buttons (a press could only fail), one line saying what to do', async () => {
    world.supported = false;
    await screen();
    expect(byId('phone-sessions-old-app')?.textContent).toBe(koMessages.desktop.phoneSessions.oldApp);
    expect(byId('phone-session-card')?.textContent).toContain('윤재의 맥북');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(byId('phone-sessions-end-all')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign')).toHaveLength(0);
  });

  it('…and the same card in English; once the computer\'s app speaks `clock` the line gives way to the buttons', async () => {
    world.supported = false;
    await screen({ locale: 'en' });
    expect(byId('phone-sessions-old-app')?.textContent).toBe(enMessages.desktop.phoneSessions.oldApp);
    world.supported = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-sessions-old-app')).toBeNull();
    expect(byId('phone-sessions-end-all')).not.toBeNull();
  });

  it('a person who may not command that computer (403) → the card is not drawn', async () => {
    world.clock = new Response(JSON.stringify({ error: { code: 'not_allowed_to_command' } }), { status: 403 });
    await screen();
    expect(byId('phone-session-card')).toBeNull();
  });

  it('a person demoted meanwhile (the next look answers 403) → the card they had is taken away, not left with stale buttons', async () => {
    await screen();
    expect(byId('phone-session-card')).not.toBeNull();
    world.clock = new Response(JSON.stringify({ error: { code: 'not_allowed_to_command' } }), { status: 403 });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-session-card')).toBeNull();
  });

  it('remote control off → one line, no buttons', async () => {
    world.remote = false;
    await screen();
    expect(byId('phone-sessions-remote-off')?.textContent).toBe(koMessages.desktop.phoneSessions.remoteOff);
    expect(byId('phone-sessions-end-all')).toBeNull();
  });

  it('some agent runs, no step open → [모든 세션 종료] under «세션 관리» and a [세션 종료] on the running agent\'s row (aria = «{이름} 세션 종료»); the other agent has no control', async () => {
    await screen();
    expect(byId('phone-session-card')?.textContent).toContain('윤재의 맥북');
    expect(byId('phone-session-card')?.textContent).toContain('세션 관리');
    expect(byId('phone-sessions-end-all')?.textContent).toBe('모든 세션 종료');
    const rows = all('phone-sessions-agent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('button')?.textContent).toBe('세션 종료');
    expect(rows[0]!.querySelector('button')?.getAttribute('aria-label')).toBe('결제 담당 세션 종료'); // the computer's tail is the card's head, not the name
  });

  it('nothing runs and nothing ended on its own → no button at all', async () => {
    world.running = false;
    await screen();
    expect(byId('phone-sessions-end-all')).toBeNull();
    expect(all('phone-sessions-agent')).toHaveLength(0);
  });

  it('the computer cannot be reached → the button is off and the reason is TEXT beside it (never `title`)', async () => {
    world.reachable = false;
    await screen();
    const b = byId('phone-sessions-end-all') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(byId('phone-sessions-unreachable')?.textContent).toBe(koMessages.desktop.phoneSessions.unreachable);
    expect(container.innerHTML).not.toMatch(/title=/);
  });

  it('an agent that ended on its own (`outs`) → «세션을 종료했어요 · {시각} — …» and [세션 시작] with aria «{이름} 세션 시작»; pressing it signs an `in` for THAT agent', async () => {
    world.running = false;
    world.view = { mode: 'none', outs: [{ agent_member_id: AGENT, name: '결제 담당', at: '2026-10-20T01:00:00Z' }] };
    await screen();
    const li = byId('phone-sessions-agent-ended')!;
    expect(li.textContent).toMatch(/세션을 종료했어요 · .+ — 시작하면 남긴 인계부터 이어서 일해요/);
    const b = li.querySelector('button')!;
    expect(b.textContent).toBe('세션 시작');
    expect(b.getAttribute('aria-label')).toBe('결제 담당 세션 시작');
    await press(b);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'in', agent_member_id: AGENT });
    expect(posts()[0]!.body).toMatchObject({ action: 'in', agent_member_id: AGENT, signed: 'SIGNED', phone_key_id: KEYID });
  });
});

describe('[4733 S4b] a press', () => {
  it('[모든 세션 종료] → the shell signs `out_open` for the computer (no agent key) → one post → followed; an `ok` leaves no line', async () => {
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_open' });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe(`/api/desktop/setups/${SETUP}/clock`);
    expect('agent_member_id' in posts()[0]!.body!).toBe(false);
    expect(byId('phone-sessions-line')?.textContent).toBe('');
  });

  it('two taps in one tick are one press', async () => {
    await screen();
    await act(async () => { (byId('phone-sessions-end-all') as HTMLElement).click(); (byId('phone-sessions-end-all') as HTMLElement).click(); });
    await flush(); await settle();
    expect(posts()).toHaveLength(1);
  });

  it('a row\'s [세션 종료] signs `out_open` for that agent', async () => {
    await screen();
    await press(all('phone-sessions-agent')[0]!.querySelector('button'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_open', agent_member_id: AGENT });
  });

  it('the person says no on the OS prompt → nothing posted and no line', async () => {
    signAnswer = { id: 's', ok: false, code: 'cancelled' };
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(posts()).toHaveLength(0);
    expect(byId('phone-sessions-line')?.textContent).toBe('');
  });

  it('«아무것도 멈추지 않았어요» only for the EXPIRED outcome (queued the whole window); a lost post is the «could not tell» line and a [결과 확인] that follows the SAME command', async () => {
    world.poll = json({ command_id: CMD, state: 'queued', result_code: null });
    await screen();
    await press(byId('phone-sessions-end-all'));
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
    await flush();
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.expired);
    expect(byId('phone-sessions-line')?.textContent).toContain('아무것도 멈추지 않았어요');
    // a post whose answer is lost
    world.poll = undefined;
    world.post = new Response('boom', { status: 500 });
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.unknown);
    expect(byId('phone-sessions-line')?.textContent).not.toContain('아무것도 멈추지 않았어요');
    expect(byId('phone-sessions-check')).not.toBeNull();
    const before = posts().length;
    await press(byId('phone-sessions-check'));
    expect(posts().length).toBe(before + 1); // no command id was ever known: the SAME post again (same key) — the server hands back the command it made, if any
    expect(posts()[before]!.body!.idempotency_key).toBe(posts()[before - 1]!.body!.idempotency_key);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign')).toHaveLength(2); // …and never a new signature for it
  });

  it.each([['already', '이미 하고 있어요'], ['not_open', '이미 닫혔어요'], ['not_ready', '초안이 오는 중이에요'], ['needs_hands', '아래 [채우기]로 채워 주세요']])('the computer\'s word «%s» has its own line', async (code, part) => {
    world.poll = json({ command_id: CMD, state: 'done', result_code: code });
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-line')?.textContent).toContain(part);
  });

  it('a press that went leaves no flow behind when the screen goes', async () => {
    await screen();
    await press(byId('phone-sessions-end-all'));
    await act(async () => { root.unmount(); });
    expect(openFlows()).toBe(0);
    root = createRoot(container);
  });
});

describe('[4733 S4b] the consent is judged from the rows themselves (fail closed)', () => {
  it('a ready row whose first line the server withheld → the button is OFF, with its reason as text', async () => {
    world.view = panel([row({ first_line: null })], { ready: 1, needs_you: 0, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-reason')?.textContent).toBe(koMessages.desktop.phoneSessions.action.lineHidden);
  });

  it('the counts say all ready but a row is still drafting → OFF (the rows win over the counts)', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', state: 'drafting', first_line: null })], { ready: 2, needs_you: 0, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the counts must agree with the rows: ready 3 but two rows shown → OFF (the counts that disagree with the rows never turn the button on)', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', first_line: '문서를 정리했어요' })], { ready: 3, needs_you: 0, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the counts say a draft is still coming while every row shown is ready → OFF (the count wins when it says «not yet»)', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', first_line: '문서를 정리했어요' })], { ready: 2, needs_you: 0, drafting: 1 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the counts say a row needs a hand while every row shown is ready → OFF (the count that says «needs you» is never ignored)', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', first_line: '문서를 정리했어요' })], { ready: 2, needs_you: 1, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a draft line with direction overrides draws without them', async () => {
    world.view = panel([row({ first_line: '\u202E결제\u2066 연동\u2069' })], { ready: 1, needs_you: 0, drafting: 0 });
    await screen();
    const line = byId('phone-sessions-first-line')?.textContent ?? '';
    expect(line).toBe('결제 연동 · ✓');
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(line)).toBe(false);
  });

  it('another organization starts from a clean slate: the card and the held unknown press of the first organization are gone', async () => {
    world.post = new Response('boom', { status: 500 });
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-check')).not.toBeNull();
    dash = { orgId: 'org-2', orgSyncPending: false };
    world.startable = { remote_control: true, computers: [{ setup_id: '55555555-6666-4777-8888-999999999999', device_name: '다른 조직 맥', reachable: true, agents: agents(true) }] };
    await screen();
    expect(byId('phone-sessions-check')).toBeNull();
    expect(byId('phone-session-card')?.textContent).toContain('다른 조직 맥');
    expect(all('phone-session-card')).toHaveLength(1);
    expect(byId('phone-session-card')?.getAttribute('data-setup')).toBe('55555555-6666-4777-8888-999999999999'); // only the new organization\'s computer
  });

  it('an idle row has no draft to show and does not hold the button', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', idle: true, first_line: null })], { ready: 2, needs_you: 0, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a one-agent panel that carries two rows is not a view this page acts on: no submit, no cancel', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당' })], { ready: 2, needs_you: 0, drafting: 0 }, { scope: 'one' });
    await screen();
    expect(byId('phone-sessions-submit')).toBeNull();
    expect(byId('phone-sessions-cancel')).toBeNull();
  });

  it('a panel with no scope (or a scope this page does not know) is not drawn as the whole computer\'s: no submit, no cancel — the card says it cannot read', async () => {
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { scope: undefined });
    await screen();
    expect(byId('phone-sessions-submit')).toBeNull();
    expect(byId('phone-sessions-cancel')).toBeNull();
    expect(byId('phone-sessions-stale')).not.toBeNull();
  });
});

describe('[4733 S4b] codex round 2 — pending holds the presses · overlapping looks · a failed first look · unreachable', () => {
  it('after an UNKNOWN end every other press is held (the next press must not overwrite it); only [결과 확인] is on', async () => {
    world.post = new Response('boom', { status: 500 });
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-check')).not.toBeNull();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(true);
    expect((all('phone-sessions-agent')[0]!.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect((byId('phone-sessions-check') as HTMLButtonElement).disabled).toBe(false);
  });

  it('[결과 확인] is off while the card cannot be trusted (stale · remote off · org sync)', async () => {
    world.post = new Response('boom', { status: 500 });
    await screen();
    await press(byId('phone-sessions-end-all'));
    world.clock = { remote_control: false, reachable: true, supported: true, view: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect((byId('phone-sessions-check') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an OLDER look that answers late does not overwrite a newer one (the late «remote control off» must not lock a card the newer look found fine)', async () => {
    await screen();
    let releaseOld!: (r: Response) => void;
    world.clock = () => new Promise<Response>((r) => { releaseOld = r; }); // the poll's look hangs…
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    world.clock = undefined; // …a newer look (after a press) answers at once
    await press(byId('phone-sessions-end-all'));
    releaseOld(json({ remote_control: false, reachable: true, supported: true, view: null })); // …and the old one arrives last
    await flush();
    expect(byId('phone-sessions-card-remote-off')).toBeNull();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the FIRST look failing leaves the card in place with «세션 상태를 불러오지 못했어요» and a way to try again (not a silent hole)', async () => {
    world.clock = new Response('boom', { status: 500 });
    await screen();
    expect(byId('phone-session-card')).not.toBeNull();
    expect(byId('phone-sessions-stale')?.textContent).toContain(koMessages.desktop.phoneSessions.readFailed);
    world.clock = undefined;
    await press(byId('phone-sessions-stale')!.querySelector('button'));
    expect(byId('phone-sessions-stale')).toBeNull();
    expect(byId('phone-sessions-end-all')).not.toBeNull();
  });

  it('«연결이 끊겨 있어요» for a press the server refused as unreachable — NOT the «아무것도 멈추지 않았어요» of an expired one', async () => {
    world.post = new Response(JSON.stringify({ error: { code: 'device_unreachable' } }), { status: 409 });
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.unreachable);
    expect(byId('phone-sessions-line')?.textContent).not.toContain('아무것도 멈추지 않았어요');
  });

  it('a one-agent panel the page cannot read as exactly one row is no card (no cancel that would name the whole computer)', async () => {
    world.view = panel([], { ready: 0, needs_you: 0, drafting: 0 }, { scope: 'one' });
    await screen();
    expect(byId('phone-sessions-cancel')).toBeNull();
    expect(byId('phone-sessions-submit')).toBeNull();
  });

  it('a panel with a row the page cannot read is no panel (the counts would be about rows nobody is looking at)', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, state: 'confused' })], { ready: 2, needs_you: 0, drafting: 0 });
    await screen();
    expect(byId('phone-sessions-submit')).toBeNull();
  });

  it('an UNKNOWN end survives the list turning to «remote control off» and back: the same command is followed (no second press, no new signature)', async () => {
    world.post = new Response('boom', { status: 500 });
    await screen();
    await press(byId('phone-sessions-end-all'));
    expect(byId('phone-sessions-check')).not.toBeNull();
    const signs = () => phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length;
    expect(signs()).toBe(1);
    world.startable = { remote_control: false, computers: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-session-card')).toBeNull(); // the section says remote control is off
    world.startable = undefined;
    world.post = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-sessions-check')).not.toBeNull(); // the card is back — with its [결과 확인]
    const before = posts().length;
    await press(byId('phone-sessions-check'));
    expect(posts()[before]!.body!.idempotency_key).toBe(posts()[0]!.body!.idempotency_key); // the SAME key (no command id was ever known): the server hands back the command it made
    expect(signs()).toBe(1);
  });

  it('an agent that ended on its own on a computer that cannot be reached: its [세션 시작] is off AND says why', async () => {
    world.running = false;
    world.reachable = false;
    world.view = { mode: 'none', outs: [{ agent_member_id: AGENT, name: '결제 담당', at: '2026-10-20T01:00:00Z' }] };
    await screen();
    expect((byId('phone-sessions-agent-ended')!.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-unreachable')?.textContent).toBe(koMessages.desktop.phoneSessions.unreachable);
    expect(byId('phone-sessions-end-all')).toBeNull();
  });

  it('the list is read one at a time: while the bridge has not answered, the poll starts no second read', async () => {
    phoneCall.mockImplementation((type: string) => (type === 'device.key.info' ? new Promise(() => {}) : Promise.resolve(signAnswer)));
    await screen();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'device.key.info')).toHaveLength(1);
  });
});

describe('[4733 S4b] what is drawn may stop being true', () => {
  it('two looks in a row that do not answer → the buttons go off and the card says it cannot read (with a way to try again); an answer brings it back', async () => {
    await screen();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(false);
    world.clock = new Response('boom', { status: 500 });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-sessions-stale')).not.toBeNull();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(true);
    world.clock = undefined;
    await press(byId('phone-sessions-stale')!.querySelector('button'));
    expect(byId('phone-sessions-stale')).toBeNull();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(false);
  });

  it('remote control turned off on the computer → one line on the card and nothing pressable', async () => {
    world.clock = { remote_control: false, reachable: true, supported: true, view: null };
    await screen();
    expect(byId('phone-sessions-card-remote-off')?.textContent).toBe(koMessages.desktop.phoneSessions.remoteOff);
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the organization is being switched (orgSyncPending) → nothing pressable; a new organization starts from a clean slate and reads again', async () => {
    dash = { orgId: 'org-1', orgSyncPending: true };
    await screen();
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(true);
    const reads = () => calls.filter((c) => c.url.startsWith('/api/desktop/startable')).length;
    dash = { orgId: 'org-2', orgSyncPending: false };
    const before = reads();
    await screen();
    expect(reads()).toBeGreaterThan(before);
    expect((byId('phone-sessions-end-all') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the card going away stops a press that is still waiting for the shell: when the signature comes later, nothing is posted', async () => {
    let release!: (v: Record<string, unknown>) => void;
    phoneCall.mockImplementation((type: string) => (type === 'device.key.info' ? Promise.resolve({ id: 'k', ok: true, key_number: '482 917' }) : new Promise((r) => { release = r; })));
    await screen();
    await act(async () => { (byId('phone-sessions-end-all') as HTMLElement).click(); });
    await flush();
    expect(openFlows()).toBeGreaterThan(0);
    await act(async () => { root.unmount(); });
    expect(openFlows()).toBe(0);
    release({ id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID });
    await flush();
    expect(posts()).toHaveLength(0);
    root = createRoot(container);
  });
});

describe('[4733 S4b] the panel (mode panel)', () => {
  it('counts, the rows with the draft\'s first line as PLAIN TEXT (a tag or url is characters), «· ✓» on a ready row; the primary button is OFF while drafts come, with its reason as text', async () => {
    world.view = panel([row({ first_line: '<b>x</b> https://evil.example' }), row({ agent_member_id: AGENT2, name: '문서 담당', state: 'drafting', first_line: null })], { ready: 1, needs_you: 0, drafting: 1 });
    await screen();
    expect(byId('phone-sessions-count')?.textContent).toBe('초안 준비됨 1 · 손 필요 0 · 초안 오는 중 1');
    const lines = all('phone-sessions-first-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe('<b>x</b> https://evil.example · ✓');
    expect(lines[0]!.querySelector('a, b')).toBeNull();
    expect(container.textContent).toContain('초안 오는 중…');
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-reason')?.textContent).toBe(koMessages.desktop.phoneSessions.action.draftsComing);
  });

  it('a row that needs a hand → the button is off, the reason + the names say so; the fields are filled in with [채우기] (S5 · P2)', async () => {
    world.view = panel([row({ state: 'needs_you', missing: ['done'], first_line: null })], { ready: 0, needs_you: 1, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-reason')?.textContent).toContain('채워야 세션을 종료할 수 있어요');
    expect(byId('phone-sessions-needs-list')?.textContent).toBe('손 필요 · 결제 담당');
    expect(container.querySelector('textarea, input')).toBeNull(); // (S5 · P2: the editor is closed until [채우기] is pressed)
    expect(byId('phone-sessions-edit-open')?.textContent).toBe('채우기');
  });

  it('a panel that has no rows yet cannot be submitted (nothing to hand over)', async () => {
    world.view = panel([], { ready: 0, needs_you: 0, drafting: 0 });
    await screen();
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('all ready → «모두 준비됐어요 — …», the button [모두 그대로 인계하고 세션 종료] is on, and its press is a signed `out_submit`; [취소] is `out_cancel`', async () => {
    world.view = panel([row({}), row({ agent_member_id: AGENT2, name: '문서 담당', first_line: '문서를 정리했어요' })], { ready: 2, needs_you: 0, drafting: 0 });
    await screen();
    expect(container.textContent).toContain('모두 준비됐어요 — 그대로 인계하고 세션을 종료할 수 있어요');
    const submit = byId('phone-sessions-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('모두 그대로 인계하고 세션 종료');
    await press(submit);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_submit' });
    await press(byId('phone-sessions-cancel'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_cancel' });
  });

  it('one agent\'s panel: its own title and lead, the one row, and a submit that names the agent in the signed call', async () => {
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { scope: 'one' });
    await screen();
    expect(byId('phone-sessions-panel')?.textContent).toContain('결제 담당 세션 종료');
    expect(byId('phone-sessions-panel')?.textContent).toContain('세션을 종료하면 이 에이전트가 멈춰요 — 한 일을 인계로 남겨요.');
    expect((byId('phone-sessions-submit') as HTMLButtonElement).textContent).toBe('인계 남기고 세션 종료');
    await press(byId('phone-sessions-submit'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_submit', agent_member_id: AGENT });
  });

  it('an idle agent ends without a handoff: the lead and the button say so', async () => {
    world.view = panel([row({ state: 'ready', idle: true, first_line: null })], { ready: 1, needs_you: 0, drafting: 0 }, { scope: 'one' });
    await screen();
    expect(byId('phone-sessions-panel')?.textContent).toContain('이번엔 한 일이 없어 인계 없이 종료해요');
    expect((byId('phone-sessions-submit') as HTMLButtonElement).textContent).toBe('세션 종료');
  });

  it('the panel lead says the app window may be closed (the daemon outlives it)', async () => {
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 });
    await screen();
    expect(byId('phone-sessions-panel')?.textContent).toContain('그 컴퓨터의 앱 창이 닫혀 있어도 세션을 종료할 수 있어요');
  });
});

describe('[4733 S4b] the card after (mode out) and the start (mode in)', () => {
  const out = (extra: Record<string, unknown> = {}) => ({ mode: 'out', opened_from: 'mac', out: { at: '2026-10-20T01:00:00Z', came: 3, warn: 'none', still_working: [], left: ['결제 담당', '문서 담당'], alone: 0, ...extra }, outs: [] });

  it('«세션을 종료했어요 · {시각}», «종료: A · B», what came in, [모든 세션 시작] → a signed `in` for the computer', async () => {
    world.view = out();
    await screen();
    const o = byId('phone-sessions-out')!;
    expect(o.textContent).toMatch(/세션을 종료했어요 · .+/);
    expect(o.textContent).toContain('종료: 결제 담당 · 문서 담당');
    expect(o.textContent).toContain('그 뒤로 들어온 일 3개 — 세션을 시작하면 하나씩 넘겨요');
    expect(byId('phone-sessions-start-all')?.textContent).toBe('모든 세션 시작');
    await press(byId('phone-sessions-start-all'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'in' });
  });

  it('more than six names → the first three and «외 k»; the still-working names; the ledger warnings', async () => {
    world.view = out({ left: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], still_working: ['결제 담당'], warn: 'full' });
    await screen();
    expect(byId('phone-sessions-out')?.textContent).toContain('종료: a · b · c 외 4');
    expect(byId('phone-sessions-out')?.textContent).toContain('세션을 종료하지 못해 아직 일하고 있어요 · 결제 담당');
    expect(byId('phone-sessions-out')?.textContent).toContain('더 받을 자리가 없어');
  });

  it('the overlap line iff k ≥ 1', async () => {
    world.view = out({ alone: 2 });
    await screen();
    expect(byId('phone-sessions-alone')?.textContent).toBe('이 중 2개는 먼저 따로 종료했어요 — 모든 세션 시작을 누르면 함께 시작해요.');
  });

  it('the overlap line is absent for 0', async () => {
    world.view = out({ alone: 0 });
    await screen();
    expect(byId('phone-sessions-alone')).toBeNull();
  });

  it('mode in: the steps, then the summary', async () => {
    world.view = { mode: 'in', opened_from: 'phone', in: { at: '2026-10-20T01:00:00Z', starting: { k: 1, n: 3 }, handing: null, came: null, failed: [], unread: [] }, outs: [] };
    await screen();
    expect(byId('phone-sessions-in')?.textContent).toContain('세션을 시작하는 중이에요 (1/3)');
    expect(byId('phone-sessions-start-all')).toBeNull();
  });
});

describe('[4733 S4b] «started elsewhere» (Yuna §5) — only where it is true', () => {
  it('opened on the Mac → the line; opened on a phone that was not this page → the line; null (an old record) → none; this page\'s own press → none', async () => {
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { opened_from: 'mac' });
    await screen();
    expect(byId('phone-sessions-elsewhere')?.textContent).toBe(koMessages.desktop.phoneSessions.elsewhere.mac);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { opened_from: 'phone' });
    await screen();
    expect(byId('phone-sessions-elsewhere')?.textContent).toBe(koMessages.desktop.phoneSessions.elsewhere.phone);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { opened_from: null });
    await screen();
    expect(byId('phone-sessions-elsewhere')).toBeNull();
  });

  it('after this page pressed [모든 세션 종료] the opened-from-phone view does not say «started from a phone» to the one who pressed', async () => {
    await screen();
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }, { opened_from: 'phone' });
    await press(byId('phone-sessions-end-all'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await flush();
    expect(byId('phone-sessions-panel')).not.toBeNull();
    expect(byId('phone-sessions-elsewhere')).toBeNull();
  });
});

describe('[4733 S4b] touch targets (Yuna: 44 px)', () => {
  it('every `size="sm"` button of this screen carries `min-h-11` (the list-step «다시 시도» was missed once) — read off the source, so a new small button without it turns this red', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'phone-session-management.tsx'), 'utf8');
    const smalls = src.split('\n').filter((l) => l.includes('size="sm"'));
    expect(smalls.length).toBeGreaterThanOrEqual(6);
    for (const l of smalls) expect(l, l.trim().slice(0, 80)).toContain('min-h-11');
  });

  it('the list-step read failure draws its [다시 시도] at 44 px', async () => {
    phoneCall.mockImplementation(async () => ({ id: 'k', ok: false, code: 'failed' }));
    await screen();
    const retry = byId('phone-sessions-read-failed')?.querySelector('button');
    expect(retry?.className).toContain('min-h-11');
  });
});

describe('[4733 S4b] words', () => {
  const strings = (o: unknown): string[] => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o as object).flatMap(strings) : []);

  it('«퇴근» / «출근» appear in no ko or en string of this screen; ko has no «#» and no code names; every string is non-empty; ko and en have the same keys', () => {
    const ko = koMessages.desktop.phoneSessions;
    const en = enMessages.desktop.phoneSessions;
    for (const s of [...strings(ko), ...strings(en)]) {
      expect(s).not.toMatch(/퇴근|출근|clock-?out|clock-?in|clocked/i);
      expect(s.trim().length).toBeGreaterThan(0);
    }
    for (const s of strings(ko)) expect(s).not.toMatch(/#|out_(open|submit|cancel)|terminated_clock|ClockFlow/);
    const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p]);
    expect(keys(ko).sort()).toEqual(keys(en).sort());
  });

  it('the screen in English draws the same controls with the English words', async () => {
    await screen({ locale: 'en' });
    expect(byId('phone-sessions-end-all')?.textContent).toBe('End all sessions');
    expect(all('phone-sessions-agent')[0]!.querySelector('button')?.getAttribute('aria-label')).toBe('End session of 결제 담당');
    expect(byId('phone-session-card')?.textContent).toContain('Session management');
  });

  it('the visible text of the screen in each state holds no «퇴근» / «출근» (rendered, not only the tables)', async () => {
    for (const view of [null, panel([row({})], { ready: 1, needs_you: 0, drafting: 0 }), { mode: 'out', opened_from: 'mac', out: { at: '2026-10-20T01:00:00Z', came: 1, warn: 'many', still_working: ['x'], left: ['y'], alone: 1 }, outs: [] }, { mode: 'in', opened_from: 'phone', in: { at: null, starting: { k: 0, n: 1 }, handing: null, came: null, failed: [], unread: [] }, outs: [] }]) {
      world.view = view as never;
      await screen();
      expect(text()).not.toMatch(/퇴근|출근/);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });
});


// ── S5 · P2: fill in and fix on the phone ──
const typeInto = async (el: HTMLElement | null, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })); });
  await flush();
};
const needsPlan = (rev = 4, extra: Record<string, unknown> = {}) => row({ state: 'needs_you', missing: ['plan'], first_line: '결제 연동을 끝냈어요', rev, ...extra });
const needsView = (rev = 4) => panel([needsPlan(rev)], { ready: 0, needs_you: 1, drafting: 0 });
const editPosts = () => posts().filter((c) => c.body?.action === 'out_edit');

describe('[4733 S5·P2] filling in and fixing on the phone', () => {
  it('a row that needs a hand has [채우기]; it opens three EMPTY fields (the empty one says so), nothing is sendable until a field is typed into', async () => {
    world.view = needsView();
    await screen();
    await press(byId('phone-sessions-edit-open'));
    const ta = (k: string) => byId(`phone-sessions-edit-${k}`) as HTMLTextAreaElement;
    expect([ta('done').value, ta('plan').value, ta('blockers').value]).toEqual(['', '', '']); // the phone is never shown the fields' text — a field it types into replaces the whole of it
    expect(ta('plan').placeholder).toBe('비어 있어요 — 여기에 써 주세요');
    expect(ta('done').placeholder).toBe('쓰지 않으면 지금 글 그대로예요');
    expect(container.textContent).toContain('쓴 칸만 바뀌어요');
    expect((byId('phone-sessions-edit-save') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-edit-nothing')?.textContent).toBe('쓴 칸이 없어요');
    await typeInto(ta('plan'), '   '); // spaces are no words
    expect((byId('phone-sessions-edit-save') as HTMLButtonElement).disabled).toBe(true);
    await press(byId('phone-sessions-edit-close'));
    expect(byId('phone-sessions-editor')).toBeNull();
  });

  it('when the card cannot be read any more (two looks in a row do not answer) [저장] goes off but [닫기] stays — a person is never kept inside an editor (codex round 2)', async () => {
    world.view = needsView(4);
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '내일 이어서 함');
    world.clock = new Response('boom', { status: 500 });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(byId('phone-sessions-stale')).not.toBeNull();
    expect((byId('phone-sessions-edit-save') as HTMLButtonElement).disabled).toBe(true);
    expect((byId('phone-sessions-edit-close') as HTMLButtonElement).disabled).toBe(false);
    await press(byId('phone-sessions-edit-close'));
    expect(byId('phone-sessions-editor')).toBeNull();
  });

  it('the ends\' blanks of a typed field are let go before it is signed (the computer saves the words trimmed — what is signed is what is stored); a line break inside stays', async () => {
    world.view = needsView(4);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 4, plan: '첫째\n둘째' } };
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '  첫째\n둘째\n ');
    await press(byId('phone-sessions-edit-save'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', expect.objectContaining({ edit: { base_rev: 4, plan: '첫째\n둘째' } }));
  });

  it('typing into one field signs an `out_edit` with the revision the screen read and ONLY that field; the shell\'s cleaned words are what is posted; ok closes the editor and shows the new view', async () => {
    world.view = needsView(4);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 4, plan: '내일 이어서 함' } };
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '내일 이어서 함');
    world.view = panel([row({ rev: 5, edited: true, first_line: '결제 연동을 끝냈어요' })], { ready: 1, needs_you: 0, drafting: 0 }); // what the computer reports after the write
    await press(byId('phone-sessions-edit-save'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_edit', agent_member_id: AGENT, edit: { base_rev: 4, plan: '내일 이어서 함' } });
    expect(editPosts()).toHaveLength(1);
    expect(editPosts()[0]!.body).toMatchObject({ action: 'out_edit', signed: 'SIGNED', phone_key_id: KEYID, agent_member_id: AGENT, edit: { base_rev: 4, plan: '내일 이어서 함' } });
    expect(Object.keys((editPosts()[0]!.body as { edit: object }).edit).sort()).toEqual(['base_rev', 'plan']); // done and blockers are not even keys
    expect(byId('phone-sessions-editor')).toBeNull();
    expect(byId('phone-sessions-line')?.textContent).toBe(''); // an `ok` says nothing: the row changes
    expect(byId('phone-sessions-first-line')?.getAttribute('data-edited')).toBe('true');
    expect(byId('phone-sessions-first-line')?.textContent).toBe('고친 글 · 결제 연동을 끝냈어요 · ✓');
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(false); // the consent button is on: the edited row shows its line
  });

  it('the words that go to the server are the shell\'s, not the page\'s: cleaned text is posted as the shell handed it back', async () => {
    world.view = needsView(2);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 2, plan: 'ab' } }; // the shell took a hidden character out
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), 'a\u200bb');
    await press(byId('phone-sessions-edit-save'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', expect.objectContaining({ edit: { base_rev: 2, plan: 'a\u200bb' } }));
    expect((editPosts()[0]!.body as { edit: unknown }).edit).toEqual({ base_rev: 2, plan: 'ab' });
  });

  it('a shell answer that does not match what was asked (another revision · another field · an extra key · a non-text field · none) is not posted — "처리하지 못했어요"', async () => {
    for (const back of [{ base_rev: 9, plan: 'x' }, { base_rev: 4, done: 'x' }, { base_rev: 4, plan: 'x', done: 'y' }, { base_rev: 4, plan: 5 }, undefined, 'plan']) {
      world.view = needsView(4);
      signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, ...(back === undefined ? {} : { edit: back }) };
      calls.length = 0;
      await screen();
      await press(byId('phone-sessions-edit-open'));
      await typeInto(byId('phone-sessions-edit-plan'), 'x');
      await press(byId('phone-sessions-edit-save'));
      expect(editPosts(), JSON.stringify(back)).toHaveLength(0);
      expect(byId('phone-sessions-line')?.textContent, JSON.stringify(back)).toBe(koMessages.desktop.phoneSessions.result.failed);
      await act(async () => { root.unmount(); }); container.remove();
      container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    }
  });

  it('all three fields typed → all three are signed and sent; a field with only spaces is not (it stays as it is on the computer)', async () => {
    world.view = needsView(0);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 0, done: 'D', plan: 'P', blockers: 'B' } };
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-done'), 'D'); await typeInto(byId('phone-sessions-edit-plan'), 'P'); await typeInto(byId('phone-sessions-edit-blockers'), 'B');
    await press(byId('phone-sessions-edit-save'));
    expect(editPosts()[0]!.body).toMatchObject({ edit: { base_rev: 0, done: 'D', plan: 'P', blockers: 'B' } });
    // …and with a blank one:
    calls.length = 0; phoneCall.mockClear();
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 0, plan: 'P2' } };
    world.view = needsView(0);
    await act(async () => { root.unmount(); }); container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-done'), '   '); await typeInto(byId('phone-sessions-edit-plan'), 'P2');
    await press(byId('phone-sessions-edit-save'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', expect.objectContaining({ edit: { base_rev: 0, plan: 'P2' } }));
  });

  it('an edit the computer never took (queued the whole window) says so — not the «no session ended» line of a press (codex round 3)', async () => {
    world.view = needsView(4);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 4, plan: '폰에서 쓴 글' } };
    world.poll = json({ command_id: CMD, state: 'queued', result_code: null });
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '폰에서 쓴 글');
    await press(byId('phone-sessions-edit-save'));
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
    await flush();
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.expiredEdit);
    expect(byId('phone-sessions-line')?.textContent).not.toContain('세션을 종료하지');
  });

  it('`stale` (the row moved on): the line says so, nothing was written, the editor stays with the typed words, and the next save names the NEW revision', async () => {
    world.view = needsView(4);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 4, plan: '폰에서 쓴 글' } };
    world.poll = json({ command_id: CMD, state: 'done', result_code: 'stale' });
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '폰에서 쓴 글');
    world.view = needsView(6); // the computer moved the row on meanwhile
    await press(byId('phone-sessions-edit-save'));
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.stale);
    expect(byId('phone-sessions-editor')).not.toBeNull();
    expect((byId('phone-sessions-edit-plan') as HTMLTextAreaElement).value).toBe('폰에서 쓴 글');
    // the screen has read the new revision: it says so, and the first [저장] only takes it (nothing is signed or sent)
    expect(byId('phone-sessions-edit-moved')?.textContent).toBe(koMessages.desktop.phoneSessions.edit.moved);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED2', phone_key_id: KEYID, edit: { base_rev: 6, plan: '폰에서 쓴 글' } };
    world.poll = json({ command_id: CMD, state: 'done', result_code: 'ok' });
    phoneCall.mockClear();
    const before = editPosts().length;
    await press(byId('phone-sessions-edit-save'));
    expect(phoneCall).not.toHaveBeenCalledWith('command.sign', expect.anything());
    expect(editPosts()).toHaveLength(before);
    expect(byId('phone-sessions-edit-moved')).toBeNull();
    await press(byId('phone-sessions-edit-save')); // the person has looked at the row as it is now: this one names the NEW revision
    expect(phoneCall).toHaveBeenCalledWith('command.sign', expect.objectContaining({ edit: { base_rev: 6, plan: '폰에서 쓴 글' } }));
  });

  it('`not_editable` has its own line; the editor stays', async () => {
    world.view = needsView(1);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 1, plan: 'x' } };
    world.poll = json({ command_id: CMD, state: 'done', result_code: 'not_editable' });
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), 'x');
    await press(byId('phone-sessions-edit-save'));
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.notEditable);
    expect(byId('phone-sessions-editor')).not.toBeNull();
  });

  it('a lost answer is "저장됐는지 확인하지 못했어요" — no [결과 확인] (nothing to redo: the next look shows what the computer holds), the edit is not repeated', async () => {
    world.view = needsView(3);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 3, plan: 'x' } };
    world.post = new Response('boom', { status: 502 });
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), 'x');
    await press(byId('phone-sessions-edit-save'));
    expect(byId('phone-sessions-line')?.textContent).toBe(koMessages.desktop.phoneSessions.result.unknownEdit);
    expect(byId('phone-sessions-check')).toBeNull();
    expect(editPosts()).toHaveLength(1);
  });

  it('only a draft that is there can be edited: not a row still drafting, an idle one, a saved one — and not while the computer cannot be reached', async () => {
    world.view = panel([row({ state: 'drafting', first_line: null }), row({ agent_member_id: AGENT2, name: '문서 담당', idle: true, first_line: null })], { ready: 1, needs_you: 0, drafting: 1 });
    await screen();
    expect(byId('phone-sessions-edit-open')).toBeNull();
    await act(async () => { root.unmount(); }); container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    world.view = needsView(); world.reachable = false;
    await screen();
    expect((byId('phone-sessions-edit-open') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a ready row can be fixed too ([고치기]); a typed line is said so — «고친 글 · …» — and the consent button needs the row\'s line like any other', async () => {
    world.view = panel([row({ rev: 2, edited: true, first_line: '사람이 쓴 문장' })], { ready: 1, needs_you: 0, drafting: 0 });
    await screen();
    expect(byId('phone-sessions-edit-open')?.textContent).toBe('고치기');
    expect(byId('phone-sessions-first-line')?.textContent).toBe('고친 글 · 사람이 쓴 문장 · ✓');
    expect((byId('phone-sessions-submit') as HTMLButtonElement).disabled).toBe(false);
    // an older computer sends neither `rev` nor `edited`: 0 and not edited
    await act(async () => { root.unmount(); }); container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    world.view = panel([row({})], { ready: 1, needs_you: 0, drafting: 0 });
    await screen();
    expect(byId('phone-sessions-first-line')?.getAttribute('data-edited')).toBe('false');
    expect(byId('phone-sessions-first-line')?.textContent).toBe('결제 연동을 끝냈어요 · ✓');
  });

  it('a field past 2000 characters cannot be saved (counted in characters, not bytes), and says so', async () => {
    world.view = needsView();
    await screen();
    await press(byId('phone-sessions-edit-open'));
    await typeInto(byId('phone-sessions-edit-plan'), '🙂'.repeat(2000));
    expect((byId('phone-sessions-edit-save') as HTMLButtonElement).disabled).toBe(false);
    expect(byId('phone-sessions-edit-too-long')).toBeNull();
    await typeInto(byId('phone-sessions-edit-plan'), '🙂'.repeat(2001));
    expect((byId('phone-sessions-edit-save') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('phone-sessions-edit-too-long')?.textContent).toBe('한 칸에 2000자까지 쓸 수 있어요');
  });

  it('the same in English: [Fill in] · the field names · the stale line', async () => {
    world.view = needsView(4);
    signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: KEYID, edit: { base_rev: 4, plan: 'x' } };
    world.poll = json({ command_id: CMD, state: 'done', result_code: 'stale' });
    await screen({ locale: 'en' });
    expect(byId('phone-sessions-edit-open')?.textContent).toBe('Fill in');
    await press(byId('phone-sessions-edit-open'));
    expect(container.textContent).toContain('Done');
    expect(container.textContent).toContain('Next');
    expect(container.textContent).toContain('Blockers');
    await typeInto(byId('phone-sessions-edit-plan'), 'x');
    await press(byId('phone-sessions-edit-save'));
    expect(byId('phone-sessions-line')?.textContent).toBe(enMessages.desktop.phoneSessions.result.stale);
  });
});
