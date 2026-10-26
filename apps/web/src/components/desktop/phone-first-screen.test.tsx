// @vitest-environment jsdom
//
// story #4714 (copy yuna/4714-copy-1017.md · contract 02d2cf71 §14): the phone app's onboarding screen — the five branches, the picker, the
// result lines. The server (5132) is not on dev yet, so every answer here is the contract's shape. Each test names the line that, reverted,
// turns it red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { __resetOrgRemoteControlForTest } from '@/lib/org-remote-control';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/lib/phone-app-store', async (orig) => ({ ...(await orig<typeof import('@/lib/phone-app-store')>()), PHONE_APP_PUBLISHED: { android: true, ios: false } }));
const { PhoneFirstScreen } = await import('./phone-first-screen');
const { FirstScreen } = await import('@/app/onboarding/first-screen');
const { isLeaving, markLeaving, clearLeaving, openFlows } = await import('@/lib/phone-start');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP = '11111111-2222-4333-8444-555555555555';
const AGENT = '22222222-3333-4444-8555-666666666666';
const AGENT2 = '22222222-3333-4444-8555-777777777777';
const PROJECT = '33333333-4444-4555-8666-777777777777';
const PROJECT2 = '33333333-4444-4555-8666-888888888888';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const computer = (over: Record<string, unknown> = {}) => ({
  setup_id: SETUP, device_name: '윤재의 맥북', reachable: true,
  agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }, { project_id: PROJECT2, name: '정산' }] }], ...over,
});

interface World { stand?: boolean; mail?: Response; devices?: unknown[]; startable?: unknown; remote?: unknown; post?: Response; poll?: Response; remotePut?: Response; hold?: Promise<void> }
let world: World;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
let started: boolean; // a start was posted: from then on the server's startable read says the agent RUNS (story 4714: started ≠ stood — the screen waits for this word)
let assigned: string[]; // the addresses the screen moved to (window.location.assign)
function server() {
  calls = [];
  started = false;
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/desktop/mac-link-mail') return world.mail ?? json({ delivered: true, email: 'me@example.test' });
    if (url === '/api/remote-devices') return json({ devices: world.devices ?? [{ id: 'p-1', confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) {
      const body = (world.startable ?? { remote_control: true, computers: [computer()] }) as { computers?: Array<{ agents?: Array<Record<string, unknown>> }> };
      if (!started || world.stand === false || !Array.isArray(body.computers)) return json(body);
      return json({ ...body, computers: body.computers.map((c) => ({ ...c, agents: (c.agents ?? []).map((a) => ({ ...a, running: true })) })) });
    }
    if (url.endsWith('/remote-control')) return method === 'PUT' ? (world.remotePut ?? json({ data: { enabled: true, enabled_at: null, can_change: true } })) : json(world.remote ?? { data: { enabled: false, enabled_at: null, can_change: true } });
    if (url.endsWith('/desktop-start')) { if (world.hold) await world.hold; started = true; return world.post ?? json({ command_id: CMD, state: 'queued' }, 201); }
    if (url.includes('/desktop-commands/')) return world.poll ?? json({ state: 'done', result_code: null });
    throw new Error(`unexpected ${method} ${url}`);
  });
}

let container: HTMLDivElement;
let root: Root;
let phoneCall: ReturnType<typeof vi.fn>;
let keyAnswer: Record<string, unknown>;
let signAnswer: Record<string, unknown>;

beforeEach(() => {
  world = {};
  keyAnswer = { id: 'k', ok: true, public_key: 'PK', key_number: '482 917' };
  signAnswer = { id: 's', ok: true, signed: 'SIGNED', phone_key_id: 'p-1' };
  phoneCall = vi.fn(async (type: string) => (type === 'device.key.info' ? keyAnswer : signAnswer));
  // the command is followed every 1.5 s (contract §11): the wait is faked, so a press runs to its END before the line is read
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); // Date too: the wait for the session stands is on the wall clock
  fetchWithAuth.mockReset();
  __resetOrgRemoteControlForTest();
  server();
  assigned = [];
  clearLeaving();
  vi.stubGlobal('location', { ...window.location, assign: (href: string) => { assigned.push(href); } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function renderIn(ui: React.ReactElement, { phone = true, locale = 'ko' as 'ko' | 'en' } = {}) {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages}>{ui}</NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await flush();
}
const screen = (opts?: Parameters<typeof renderIn>[1]) => renderIn(<PhoneFirstScreen orgId="org-1" chatsHref="/chats" />, opts);
const text = () => container.textContent ?? '';
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); await flush(); };
const press = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); await settle(); };
const pickFromSheet = async (rowId: string, name: string) => {
  await press(byId(rowId));
  const row = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).find((r) => r.textContent?.includes(name));
  await press(row ?? null);
};

describe('[4780] the pairing link of the start screen', () => {
  it('a screen that hands over a way back (the sign-up screen: Today) carries it as `from`, so [Close] of the pairing screen goes there', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await renderIn(<PhoneFirstScreen orgId="org-1" chatsHref="/chats" returnHref="/org-briefing" />);
    expect(byId('onboarding-phone-pair')?.getAttribute('href')).toContain('/desktop/pair?from=%2Forg-briefing'); // reverted (no returnHref) → no `from`
  });
  it('without one the link is the address it always was (the screen is not a way back by itself)', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await screen();
    expect(byId('onboarding-phone-pair')?.getAttribute('href')).not.toContain('from=');
  });
  it('a way back that is not one of the app\'s own screens is dropped', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await renderIn(<PhoneFirstScreen orgId="org-1" chatsHref="/chats" returnHref="//evil.example/today" />);
    expect(byId('onboarding-phone-pair')?.getAttribute('href')).not.toContain('evil');
  });
});

describe('[4714] branch 2 — no paired computer (AC2)', () => {
  it('this phone\'s key is not on the server\'s list → «에이전트는 Mac에서 돌아가요» + the pairing link; no mail button where the Mac app is not offered (the server says so)', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await screen();
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
    expect(text()).toContain('에이전트는 Mac에서 돌아가요');
    expect(byId('onboarding-phone-pair')?.getAttribute('href')).toContain('/desktop/pair');
    expect(text()).not.toMatch(/메일|Email/);
    expect(calls.map((c) => c.url)).toEqual(['/api/remote-devices']); // no startable read for a key the server does not know
  });

  it('paired with nothing (the key is known, the list of computers is empty) → the same screen', async () => {
    world.startable = { remote_control: true, computers: [] };
    await screen();
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
  });

  it('a phone with no screen lock gets the same screen (the pairing page says why)', async () => {
    keyAnswer = { id: 'k', ok: false, code: 'no_screen_lock' };
    await screen();
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
  });
});

const mailScreen = (opts?: Parameters<typeof renderIn>[1]) => renderIn(<PhoneFirstScreen orgId="org-1" chatsHref="/chats" macDownloadEnabled />, opts);
const mailCalls = () => calls.filter((c) => c.url === '/api/desktop/mac-link-mail');

describe('[4714 AC2] «Mac에서 열 링크를 메일로 받기» (Yuna 4714-ac2-mac-link-mail-copy-1018)', () => {
  beforeEach(() => { world.devices = [{ id: 'x', confirm_number: '000 000' }]; }); // the no-Mac screen

  it('drawn only where the Mac app is offered: macDownloadEnabled false/absent → no button and no mail line', async () => {
    await screen();
    expect(byId('onboarding-phone-mail')).toBeNull();
    expect(text()).not.toMatch(/메일|Email/);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mailScreen();
    expect(byId('onboarding-phone-mail-button')?.textContent).toBe('Mac에서 열 링크를 메일로 받기');
    expect(byId('onboarding-phone-pair')?.getAttribute('href')).toContain('/desktop/pair');
  });

  it('the first screen hands the flag down: FirstScreen in the phone app draws the mail button only with macDownloadEnabled', async () => {
    const withFlag = <FirstScreen orgId="org-1" chatsHref="/chats" macDownloadEnabled orgName={null} onFinish={() => {}} />;
    const withoutFlag = <FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onFinish={() => {}} />;
    await renderIn(withoutFlag, { phone: true });
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
    expect(byId('onboarding-phone-mail')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await renderIn(withFlag, { phone: true });
    expect(byId('onboarding-phone-mail-button')).not.toBeNull();
  });

  it('pressing it POSTs with no body and no address; a delivered mail says where it went (status, not an alert) with [다시 받기] and no button', async () => {
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    expect(mailCalls()).toEqual([{ url: '/api/desktop/mac-link-mail', method: 'POST', body: undefined }]);
    const sent = byId('onboarding-phone-mail-sent');
    expect(sent?.textContent).toContain('메일을 보냈어요 · me@example.test — Mac에서 이 메일을 열어 링크를 눌러 주세요.');
    expect(sent?.getAttribute('role')).toBe('status');
    expect(byId('onboarding-phone-mail-button')).toBeNull();
    expect(byId('onboarding-phone-mail-again')?.textContent).toBe('다시 받기');
    expect(byId('onboarding-phone-pair')).not.toBeNull();
    expect(byId('onboarding-phone-pair')?.closest('[hidden]')).toBeNull(); // drawn AND shown, not just present
  });

  it('[다시 받기] makes the same call again', async () => {
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    await press(byId('onboarding-phone-mail-again'));
    expect(mailCalls()).toHaveLength(2);
  });

  it('a mail that was not delivered (delivered:false) is the failure alert, never the sent line; the button is back', async () => {
    world.mail = json({ delivered: false, email: 'me@example.test' });
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    expect(byId('onboarding-phone-mail-sent')).toBeNull();
    const failed = byId('onboarding-phone-mail-failed');
    expect(failed?.textContent).toBe('메일을 보내지 못했어요 — 다시 눌러 주세요');
    expect(failed?.getAttribute('role')).toBe('alert');
    expect(byId('onboarding-phone-mail-button')).not.toBeNull();
  });

  it('429 → the limit line (status) and the button stays; 409 email_not_verified → the verify line and no button', async () => {
    world.mail = json({ error: { code: 'rate_limited' } }, 429);
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    expect(byId('onboarding-phone-mail-limited')?.textContent).toContain('잠깐 사이에 너무 자주 받았어요');
    expect(byId('onboarding-phone-mail-limited')?.getAttribute('role')).toBe('status');
    expect(byId('onboarding-phone-mail-button')).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    world.mail = json({ error: { code: 'email_not_verified' } }, 409);
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    expect(byId('onboarding-phone-mail-need-verify')?.textContent).toBe('이메일 인증이 필요해요 — 링크를 받으려면 먼저 이메일 인증을 완료해 주세요.');
    expect(byId('onboarding-phone-mail-button')).toBeNull();
    expect(byId('onboarding-phone-pair')).not.toBeNull();
    expect(byId('onboarding-phone-pair')?.closest('[hidden]')).toBeNull();
  });

  it('409 download_not_enabled → nothing is drawn: no button, no line (the screen never promises a mail the server will not send)', async () => {
    world.mail = json({ error: { code: 'download_not_enabled' } }, 409);
    await mailScreen();
    await press(byId('onboarding-phone-mail-button'));
    expect(byId('onboarding-phone-mail')).toBeNull();
    expect(text()).not.toMatch(/메일|Email/);
    expect(byId('onboarding-phone-pair')).not.toBeNull();
  });

  it('one mail per press: two taps in the same tick send one; while the call is out the button is off and says so; a lost answer is the failure line', async () => {
    let release: (r: Response) => void = () => undefined;
    world.mail = undefined;
    const held = new Promise<Response>((r) => { release = r; });
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (url === '/api/desktop/mac-link-mail' ? (calls.push({ url, method: init?.method ?? 'GET', body: undefined }), held) : base(url, init)));
    await mailScreen();
    const first = byId('onboarding-phone-mail-button') as HTMLButtonElement;
    await act(async () => { first.click(); first.click(); }); // both read the same render: only a ref guard sees the first
    await flush();
    expect(mailCalls()).toHaveLength(1);
    const button = byId('onboarding-phone-mail-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('보내는 중이에요…');
    await act(async () => { release(new Response('x', { status: 500 })); });
    await flush();
    expect(byId('onboarding-phone-mail-failed')).not.toBeNull();
    await press(byId('onboarding-phone-mail-button')); // the lock is lifted after the end: pressing again sends again
    expect(mailCalls()).toHaveLength(2);
  });

  it('en: the same states in English', async () => {
    await mailScreen({ locale: 'en' });
    expect(byId('onboarding-phone-mail-button')?.textContent).toBe('Email me a link to open on my Mac');
    await press(byId('onboarding-phone-mail-button'));
    expect(byId('onboarding-phone-mail-sent')?.textContent).toContain('Sent to me@example.test — open the email on your Mac and click the link.');
    expect(byId('onboarding-phone-mail-again')?.textContent).toBe('Send again');
  });
});

describe('[4714] branch 1 — remote control is off', () => {
  it('the person who can switch it gets one button; pressing it PUTs the org\'s switch and the screen moves on with no line', async () => {
    world.startable = { remote_control: false, computers: [computer()] };
    await screen();
    expect(text()).toContain('이 조직은 원격 제어가 꺼져 있어요');
    expect(text()).toContain('켜야 이 폰에서 에이전트를 시작할 수 있어요.');
    const on = byId('onboarding-phone-turn-on');
    expect(on?.textContent).toBe('원격 제어 켜기');
    world.startable = { remote_control: true, computers: [computer()] };
    await press(on);
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/organizations/org-1/remote-control')).toBe(true);
    expect(byId('onboarding-phone-start')).not.toBeNull(); // the next branch, no confirmation line
    expect(text()).not.toContain('켜졌어요');
  });

  it('a screen MOUNTED inside the way-out window still reads and draws (the window stops what is out and blocks presses — it never blanks a fresh screen)', async () => {
    markLeaving();
    await screen();
    expect(byId('onboarding-phone-start')).not.toBeNull();
  });

  it('the switch answers AFTER a way out was pressed: the screen is not blanked by a read that is refused (it stays as it was)', async () => {
    world.startable = { remote_control: false, computers: [computer()] };
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/remote-control') && init?.method === 'PUT') { await held; return json({ data: { enabled: true, enabled_at: null, can_change: true } }); }
      if (url === '/api/remote-devices') return json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      if (url.startsWith('/api/desktop/startable')) return json(world.startable);
      if (url.endsWith('/remote-control')) return json({ data: { enabled: false, enabled_at: null, can_change: true } });
      if (url === '/api/auth/me') return json({ data: { org_id: 'org-1', org_member_id: 'om-1' } });
      throw new Error(`unexpected ${url}`);
    });
    await screen();
    await act(async () => { (byId('onboarding-phone-turn-on') as HTMLElement).click(); });
    await flush();
    markLeaving();
    release();
    await flush(); await settle();
    expect(byId('onboarding-phone-reading')).toBeNull(); // not the blank «reading» area
    expect(byId('onboarding-phone-off')).not.toBeNull(); // the card it was
  });

  it('a person who cannot switch it gets the body only — no button', async () => {
    world.startable = { remote_control: false, computers: [computer()] };
    world.remote = { data: { enabled: false, enabled_at: null, can_change: false } };
    await screen();
    expect(text()).toContain('소유자 · 관리자가 켜면 이 폰에서 에이전트를 시작할 수 있어요.');
    expect(byId('onboarding-phone-turn-on')).toBeNull();
  });

  it('a switch that failed says so under the button and stays', async () => {
    world.startable = { remote_control: false, computers: [computer()] };
    world.remotePut = json({ error: { code: 'forbidden' } }, 403);
    await screen();
    await press(byId('onboarding-phone-turn-on'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('켜지 못했어요 — 다시 눌러 주세요');
    expect(byId('onboarding-phone-turn-on')).not.toBeNull();
  });

  it('off comes before «no computer»: pairing is refused while it is off', async () => {
    world.startable = { remote_control: false, computers: [] };
    await screen();
    expect(byId('onboarding-phone-off')).not.toBeNull();
    expect(byId('onboarding-phone-no-mac')).toBeNull();
  });
});

describe('[SID:4714] a computer whose agents the person may not talk to says so (the server left them out)', () => {
  it('agents_hidden: message_policy and nothing left → its own line (not «no agent yet»), no button', async () => {
    world.startable = { remote_control: true, computers: [{ ...computer({ agents: [] }), agents_hidden: 'message_policy' as const }] };
    await screen();
    expect(byId('onboarding-phone-no-agent')?.textContent).toBe('윤재의 맥북의 에이전트는 대화가 허용된 사람만 시작할 수 있어요 — 에이전트를 만든 사람이나 관리자에게 허용을 부탁해 주세요.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
  it('the flag is ignored when nothing says it (a computer with no agent at all keeps «start the first agent at the Mac»)', async () => {
    world.startable = { remote_control: true, computers: [computer({ agents: [] })] };
    await screen();
    expect(byId('onboarding-phone-no-agent')?.textContent).toBe('윤재의 맥북에는 아직 에이전트가 없어요 — Mac 앞에서 폴더를 고르고 첫 에이전트를 시작해 주세요.');
  });
  it('English words', async () => {
    world.startable = { remote_control: true, computers: [{ ...computer({ agents: [] }), agents_hidden: 'message_policy' as const }] };
    await screen({ locale: 'en' });
    expect(byId('onboarding-phone-no-agent')?.textContent).toContain('Only people who are allowed to chat with the agents on');
  });
});

describe('[4714] branch 3 — a paired computer with no agent', () => {
  it('one line with the computer\'s own name, no button, no picker', async () => {
    world.startable = { remote_control: true, computers: [computer({ agents: [] })] };
    await screen();
    expect(byId('onboarding-phone-no-agent')?.textContent).toBe('윤재의 맥북에는 아직 에이전트가 없어요 — Mac 앞에서 폴더를 고르고 첫 에이전트를 시작해 주세요.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(byId('onboarding-phone-start')).toBeNull();
  });
});

describe('[4714] branch 4 — start (AC3)', () => {
  it('one agent is picked already; [시작] is off with a visible reason until a project is picked; the title names the computer', async () => {
    await screen();
    expect(text()).toContain('윤재의 맥북에서 에이전트를 시작할까요?');
    expect(byId('onboarding-phone-agent-fixed')?.textContent).toContain('결제 담당');
    expect(byId('onboarding-phone-agent')).toBeNull(); // no picker for one row
    const go = byId('onboarding-phone-start-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(byId('onboarding-phone-reason')?.textContent).toBe('프로젝트를 고르면 시작할 수 있어요');
    expect(byId('onboarding-phone-new-folder')?.textContent).toBe('새 폴더는 Mac 앞에서 골라요');
  });

  it('the project sheet lists names only; picking one enables [시작]; pressing it asks the shell for the three ids and posts the closed body', async () => {
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    expect(byId('onboarding-phone-reason')).toBeNull();
    const go = byId('onboarding-phone-start-go') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await press(go);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'start_session', setup_id: SETUP, agent_member_id: AGENT, project_id: PROJECT });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/api/agents/${AGENT}/desktop-start`);
    expect(Object.keys(post.body!).sort()).toEqual(['idempotency_key', 'phone_key_id', 'project_id', 'setup_id', 'signed']);
    expect(byId('onboarding-phone-result')).toBeNull(); // started: no refusal line
    expect(assigned).toEqual([`/onboarding/first-instruction?agent=${AGENT}&project=${PROJECT}`]); // the session stood → the conversation with THIS agent (the onboarding's own find-or-create route)
  });

  it('several agents: each has its own projects; choosing another agent clears the project', async () => {
    world.startable = { remote_control: true, computers: [computer({ agents: [
      { agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }] },
      { agent_member_id: AGENT2, name: '문서 담당', can_command: true, projects: [{ project_id: PROJECT2, name: '정산' }] },
    ] })] };
    await screen();
    expect(byId('onboarding-phone-reason')?.textContent).toBe('에이전트를 고르면 시작할 수 있어요');
    await pickFromSheet('onboarding-phone-agent', '결제 담당');
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false);
    await pickFromSheet('onboarding-phone-agent', '문서 담당');
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('onboarding-phone-reason')?.textContent).toBe('프로젝트를 고르면 시작할 수 있어요');
    await press(byId('onboarding-phone-project'));
    const names = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).map((r) => r.textContent);
    expect(names).toEqual(['정산']);
  });

  it('no path or folder name is drawn anywhere (the data has none to draw)', async () => {
    world.startable = { remote_control: true, computers: [computer({ path: '/Users/yoonjae/secret', agents: [{ agent_member_id: AGENT, name: 'A', can_command: true, cwd: '/Users/x', projects: [{ project_id: PROJECT, name: 'P', folder: '/Users/y' }] }] })] };
    await screen();
    await press(byId('onboarding-phone-project'));
    expect(container.innerHTML).not.toMatch(/\/Users\//);
  });
});

describe('[4714] two paired computers — the person chooses the computer (PO 10-19: never «one Mac» assumed)', () => {
  const SETUP2 = '11111111-2222-4333-8444-666666666666';
  const two = (over: Record<string, unknown> = {}) => ({ remote_control: true, computers: [computer(), computer({ setup_id: SETUP2, device_name: '사무실 맥', ...over })] });

  it('with ONE computer that can take a start there is no computer row; with two there is one, and it shows the computer the screen is for', async () => {
    await screen();
    expect(byId('onboarding-phone-computer')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    world.startable = two();
    await screen();
    expect(byId('onboarding-phone-computer')?.textContent).toContain('컴퓨터');
    expect(byId('onboarding-phone-computer')?.textContent).toContain('윤재의 맥북'); // the first one that can take a start (reachable first) is the shown one
    expect(text()).toContain('윤재의 맥북에서 에이전트를 시작할까요?');
  });

  it('choosing the other computer rebuilds the screen for it: its name in the title, the project pick cleared, and the start is signed for THAT computer', async () => {
    world.startable = two();
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false);
    await pickFromSheet('onboarding-phone-computer', '사무실 맥');
    expect(text()).toContain('사무실 맥에서 에이전트를 시작할까요?');
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true); // the project of the first computer is not carried over
    await pickFromSheet('onboarding-phone-project', '정산');
    await press(byId('onboarding-phone-start-go'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'start_session', setup_id: SETUP2, agent_member_id: AGENT, project_id: PROJECT2 });
  });

  it('a computer the person cannot command anything on is not offered as a choice; the unreachable one is only the second choice', async () => {
    world.startable = { remote_control: true, computers: [
      computer({ setup_id: SETUP2, device_name: '꺼진 맥', reachable: false }),
      computer({ setup_id: '11111111-2222-4333-8444-777777777777', device_name: '권한 없는 맥', agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: false, projects: [{ project_id: PROJECT, name: '결제 개편' }] }] }),
      computer(),
    ] };
    await screen();
    expect(text()).toContain('윤재의 맥북에서 에이전트를 시작할까요?'); // the reachable one first
    await press(byId('onboarding-phone-computer'));
    const names = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).map((r) => r.textContent);
    expect(names.some((n) => n?.includes('꺼진 맥'))).toBe(true);
    expect(names.some((n) => n?.includes('윤재의 맥북'))).toBe(true);
    expect(names.some((n) => n?.includes('권한 없는 맥'))).toBe(false);
  });

  it('a computer none of whose agents has a project to start is no choice (an empty list with a start that cannot be pressed); with none to choose between there is no row', async () => {
    world.startable = two({ agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [] }] });
    await screen();
    expect(byId('onboarding-phone-computer')).toBeNull(); // only the first computer has a project to start
    expect(text()).toContain('윤재의 맥북에서 에이전트를 시작할까요?');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    world.startable = { remote_control: true, computers: [
      computer({ agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [] }] }),
      computer({ setup_id: SETUP2, device_name: '사무실 맥', agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [] }] }),
      computer({ setup_id: '11111111-2222-4333-8444-777777777777', device_name: '권한 없는 맥', agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: false, projects: [] }] }),
    ] };
    await screen();
    expect(byId('onboarding-phone-computer')).not.toBeNull(); // none has a project: the two the person may command are offered, the card says what it can
    await press(byId('onboarding-phone-computer'));
    const names = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).map((r) => r.textContent ?? '');
    expect(names.length).toBe(2);
    expect(names.some((n) => n.includes('권한 없는 맥'))).toBe(false); // …and a computer with nothing the person may command is no choice even then
  });

  it('while a start is out the computer row is off — switching would drop the result of a start that is already on its way', async () => {
    world.startable = two();
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    expect((byId('onboarding-phone-computer') as HTMLButtonElement).disabled).toBe(true);
    release();
    await flush();
  });
});

describe('[4714] branch 5 — the result lines', () => {
  const start = async () => { await screen(); await pickFromSheet('onboarding-phone-project', '결제 개편'); await press(byId('onboarding-phone-start-go')); };
  const line = () => byId('onboarding-phone-result')?.querySelector('p');

  it('already_running is a neutral status (not an alert) with [대화 열기]', async () => {
    world.poll = json({ state: 'rejected', result_code: 'already_running' });
    await start();
    expect(line()?.getAttribute('role')).toBe('status');
    expect(line()?.textContent).toBe('이미 돌고 있는 에이전트예요 — 대화에서 이어 가세요');
    expect(byId('onboarding-phone-open-chat')?.textContent).toBe('대화 열기');
    expect(byId('onboarding-phone-open-chat')?.getAttribute('href')).toBe('/chats'); // the page's own resolved destination
  });

  it('no_folder → «이 프로젝트는 Mac에서 아직 폴더를 고르지 않았어요 …» as an alert', async () => {
    world.post = json({ error: { code: 'no_folder' } }, 409);
    await start();
    expect(line()?.getAttribute('role')).toBe('alert');
    expect(line()?.textContent).toBe('이 프로젝트는 Mac에서 아직 폴더를 고르지 않았어요 — Mac 앞에서 폴더를 골라 주세요');
  });

  it('device_unreachable · phone_not_paired · a shell refusal each get their own line', async () => {
    world.post = json({ error: { code: 'device_unreachable' } }, 409);
    await start();
    expect(line()?.textContent).toContain('그 컴퓨터에 지금 닿지 않아요');
    world.post = json({ error: { code: 'phone_not_paired' } }, 409);
    await press(byId('onboarding-phone-start-go'));
    expect(line()?.textContent).toContain('이 폰은 그 컴퓨터와 페어링되어 있지 않아');
    signAnswer = { id: 's', ok: false, code: 'no_screen_lock' };
    await press(byId('onboarding-phone-start-go'));
    expect(line()?.textContent).toContain('화면 잠금이 없는 폰에서는 시작할 수 없어요');
  });

  it('cancelled is not a failure: no line at all, the screen is ready again', async () => {
    signAnswer = { id: 's', ok: false, code: 'cancelled' };
    await start();
    expect(byId('onboarding-phone-result')).toBeNull();
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('remote control found off → the screen goes back to branch 1', async () => {
    signAnswer = { id: 's', ok: false, code: 'remote_control_off' };
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    world.startable = { remote_control: false, computers: [computer()] };
    await press(byId('onboarding-phone-start-go'));
    expect(byId('onboarding-phone-off')).not.toBeNull();
  });

  it('unknown keeps the press and shows [결과 확인]; pressing it follows the same command and signs nothing new', async () => {
    world.post = json({ error: { code: 'INTERNAL_ERROR' } }, 500);
    await start();
    expect(line()?.textContent).toBe('시작했는지 아직 몰라요 — 잠시 뒤 [결과 확인]을 눌러 주세요');
    expect(line()?.getAttribute('role')).toBe('status');
    const signs = phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length;
    world.post = json({ command_id: CMD, state: 'queued' }, 201);
    await press(byId('onboarding-phone-check'));
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length).toBe(signs);
    expect(byId('onboarding-phone-result')).toBeNull(); // it started
    expect(assigned).toEqual([`/onboarding/first-instruction?agent=${AGENT}&project=${PROJECT}`]); // [결과 확인] that ends «started» goes on the same way as a press that did
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts[0]!.body!.idempotency_key).toBe(posts[1]!.body!.idempotency_key);
  });
});

describe('[4714] codex round 1 — a start of unknown end is locked; only agents the person may command are offered', () => {
  it('after an unknown end [시작] and both pickers are off — a new press would sign again and could start it twice; [결과 확인] lifts the lock', async () => {
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    world.post = json({ error: { code: 'INTERNAL_ERROR' } }, 500);
    await press(byId('onboarding-phone-start-go'));
    expect(byId('onboarding-phone-check')).not.toBeNull();
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true);
    expect((byId('onboarding-phone-project') as HTMLButtonElement).disabled).toBe(true);
    const signs = phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length;
    await press(byId('onboarding-phone-start-go')); // a press on a disabled button does nothing
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length).toBe(signs);
    world.post = json({ command_id: CMD, state: 'queued' }, 201);
    await press(byId('onboarding-phone-check'));
    expect((byId('onboarding-phone-check'))).toBeNull(); // it started — the lock is lifted (the screen is on its way to the conversation)
    expect(assigned.length).toBe(1);
  });

  it('while a start is in flight the pickers and [시작] are off; a choice made on a sheet that was already open is ignored once the end is unknown', async () => {
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-project')); // a sheet is open …
    let release: () => void = () => {};
    world.hold = new Promise<void>((r) => { release = r; });
    world.post = json({ error: { code: 'INTERNAL_ERROR' } }, 500);
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); }); // … and the start goes out meanwhile
    await flush();
    expect((byId('onboarding-phone-project') as HTMLButtonElement).disabled).toBe(true); // busy: the picker is off
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    await settle();
    expect(byId('onboarding-phone-check')).not.toBeNull(); // unknown
    const row = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).find((r) => r.textContent?.includes('정산'));
    await press(row ?? null); // a choice on the open sheet: ignored
    expect(byId('onboarding-phone-check')).not.toBeNull(); // the lock and the pending are still there
    expect(byId('onboarding-phone-project')?.textContent).toContain('결제 개편'); // the pick did not move
  });

  it('an agent with can_command false is not offered (no row, no picker choice); with only such agents the screen says there is none to start', async () => {
    world.startable = { remote_control: true, computers: [computer({ agents: [
      { agent_member_id: AGENT, name: '내가 못 시키는', can_command: false, projects: [{ project_id: PROJECT, name: '결제 개편' }] },
      { agent_member_id: AGENT2, name: '문서 담당', can_command: true, projects: [{ project_id: PROJECT2, name: '정산' }] },
    ] })] };
    await screen();
    expect(byId('onboarding-phone-agent-fixed')?.textContent).toContain('문서 담당'); // the only commandable one is picked already
    expect(text()).not.toContain('내가 못 시키는');
    world.startable = { remote_control: true, computers: [computer({ agents: [{ agent_member_id: AGENT, name: '내가 못 시키는', can_command: false, projects: [{ project_id: PROJECT, name: '결제 개편' }] }] })] };
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await screen();
    expect(byId('onboarding-phone-no-agent')?.textContent).toBe('윤재의 맥북에는 내가 시작할 수 있는 에이전트가 없어요.'); // Yuna 4714 §5: not «아직 에이전트가 없어요» — it has some
    expect(byId('onboarding-phone-start')).toBeNull();
  });
});

describe('[4714] codex round 3 — a rejected bridge call and an unreadable org switch are never a dead end', () => {
  it('a rejected command.sign leaves [시작] usable again with the failure line (not busy forever)', async () => {
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    phoneCall.mockImplementation(async (type: string) => { if (type === 'command.sign') throw new Error('bridge'); return keyAnswer; });
    await press(byId('onboarding-phone-start-go'));
    expect(byId('onboarding-phone-result')?.querySelector('p')?.textContent).toBe('시작하지 못했어요 — 다시 눌러 주세요');
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a rejected device.key.info ends the reading with the read-failed screen and its retry (not «reading» forever)', async () => {
    phoneCall.mockImplementation(async () => { throw new Error('bridge'); });
    await screen();
    expect(byId('onboarding-phone-read-failed')).not.toBeNull();
  });

  it('remote control off and the org switch cannot be read: a line and one retry — not the non-owner copy with nothing to press', async () => {
    world.startable = { remote_control: false, computers: [computer()] };
    world.remote = undefined;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/remote-devices') return json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      if (url.startsWith('/api/desktop/startable')) return json({ remote_control: false, computers: [computer()] });
      return json({}, 500); // the org switch's read
    });
    await screen();
    expect(byId('onboarding-phone-off')).not.toBeNull();
    expect(text()).not.toContain('소유자 · 관리자가 켜면'); // no guess at who may turn it on while it is unknown
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); // the retries of the read (1.5 s · 4 s) run out
    await flush();
    expect(byId('onboarding-phone-off-read-failed')?.textContent).toContain('불러오지 못했어요 — 다시 눌러 주세요');
    expect(byId('onboarding-phone-off-read-failed')?.querySelector('p')?.getAttribute('role')).toBe('alert');
    expect(text()).not.toContain('소유자 · 관리자가 켜면');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '다시 불러오기')).toBe(true);
  });
});

describe('[4714] a read that failed, and the screen outside the phone app', () => {
  it('a failed read says so with one button that reads again', async () => {
    fetchWithAuth.mockImplementation(async () => json({}, 500));
    await screen();
    expect(byId('onboarding-phone-read-failed')?.textContent).toContain('불러오지 못했어요 — 다시 눌러 주세요');
    expect(byId('onboarding-phone-read-failed')?.querySelector('p')?.getAttribute('role')).toBe('alert'); // a failure, not a status (Yuna 4714 §5)
    server();
    await press(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다시 불러오기') ?? null);
    expect(byId('onboarding-phone-start')).not.toBeNull();
  });

  it('while reading: an empty area (no branch is drawn before the answer)', async () => {
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementation(() => new Promise<Response>((r) => { release = r; }));
    await screen();
    expect(byId('onboarding-phone-reading')).not.toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    await act(async () => { release(json({ devices: [] })); });
  });
});

describe('[4714] AC1 — the first screen inside the phone app', () => {
  const first = <FirstScreen orgId="org-1" chatsHref="/chats" orgName="문클랩스" onFinish={() => {}} />;
  it('inside the phone app the Mac-or-not fork is not drawn: «지금은 Mac 앱만 있어요» · the web-way button · the download card are gone, the phone screen is there', async () => {
    await renderIn(first, { phone: true });
    expect(byId('onboarding-first-phone-app')).not.toBeNull();
    expect(byId('onboarding-phone-start')).not.toBeNull();
    expect(text()).not.toContain('지금은 Mac 앱만 있어요');
    expect(byId('onboarding-first-advanced')).toBeNull();
    expect(byId('onboarding-first-not-mac')).toBeNull();
    expect(byId('onboarding-first-finish')).not.toBeNull(); // the person can still leave for «오늘»
  });

  it('outside the phone app (a phone\'s browser · a Mac) the first screen is what it was', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36', configurable: true });
    await renderIn(first, { phone: false });
    expect(byId('onboarding-first-phone-app')).toBeNull();
    expect(byId('onboarding-first-not-mac')).not.toBeNull();
    expect(text()).toContain('지금은 Mac 앱만 있어요');
  });
});

describe('[4714] the words (Yuna\'s sheet)', () => {
  type Tree = { [k: string]: string | Tree };
  const flat = (o: Tree, p = ''): Record<string, string> => Object.entries(o).reduce((a, [k, v]) => (typeof v === 'string' ? { ...a, [`${p}${k}`]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
  const ko = flat((koMessages as unknown as { onboarding: { phone: Tree } }).onboarding.phone);
  const en = flat((enMessages as unknown as { onboarding: { phone: Tree } }).onboarding.phone);
  it('ko and en have the same keys with the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
    const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join();
    for (const k of Object.keys(ko)) expect(ph(en[k])).toBe(ph(ko[k]));
  });
  it('the agent and the project are rows, never a placeholder inside a sentence; no «셋업» on this screen; «Mac» is named only where there is no Mac yet', () => {
    for (const [k, v] of Object.entries(ko)) { expect(v).not.toMatch(/\{(agent|project)\}/); expect(v).not.toContain('셋업'); void k; }
    expect(ko['start.title']).toContain('{device}');
    expect(ko['noAgent.line']).toContain('{device}');
    expect(ko['start.title']).not.toMatch(/맥/);
  });
  it('[story 4762] the no-Mac body names the steps in the order they are done: get the app → sign in → START AN AGENT → pair this phone (the Mac only shows the pairing QR once an agent exists)', () => {
    const koBody = ko['noMac.body']!;
    const enBody = en['noMac.body']!;
    expect(koBody.indexOf('에이전트를 시작')).toBeGreaterThan(-1);
    expect(koBody.indexOf('에이전트를 시작')).toBeLessThan(koBody.indexOf('페어링'));
    expect(enBody.indexOf('start an agent')).toBeGreaterThan(-1);
    expect(enBody.indexOf('start an agent')).toBeLessThan(enBody.indexOf('pair this phone'));
  });
  it('[AC2] the mail lines: exactly the sheet\'s seven keys, the same in ko and en, with {email} as the only placeholder (no particle after an address)', () => {
    const keys = ['noMac.mail', 'noMac.mailAgain', 'noMac.mailFailed', 'noMac.mailLimited', 'noMac.mailNeedVerify', 'noMac.mailSending', 'noMac.mailSent'];
    expect(Object.keys(ko).filter((k) => /mail/i.test(k)).sort()).toEqual(keys);
    expect(Object.keys(en).filter((k) => /mail/i.test(k)).sort()).toEqual(keys);
    for (const k of keys) {
      const placeholders = (v: string) => (v.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      expect(placeholders(ko[k])).toEqual(placeholders(en[k]));
      expect(placeholders(ko[k])).toEqual(k === 'noMac.mailSent' ? ['{email}'] : []);
    }
    expect(ko['noMac.mailSent']).not.toMatch(/\{email\}[은는이가을를의에도]/); // a particle straight after an address is not safe
  });
  it('the refusals reuse the phone lines\' shape: each ends in an instruction (a started start has only the «waiting to connect» line · a cancelled one none)', () => {
    expect(Object.keys(ko).filter((k) => k.startsWith('result.')).sort()).toEqual([
      'result.alreadyRunning', 'result.biometricRequired', 'result.check', 'result.connecting', 'result.failed', 'result.keyInvalidated', 'result.noFolder', 'result.noScreenLock', 'result.notPaired',
      'result.notRegistered', 'result.openChat', 'result.readFailed', 'result.remoteOff', 'result.retry', 'result.signedOut', 'result.unknown', 'result.unreachable',
    ].sort());
  });
});

describe('[4714] AC3 — started ≠ stood: the conversation with the started agent opens when the server says it runs', () => {
  const FIRST = `/onboarding/first-instruction?agent=${AGENT}&project=${PROJECT}`;
  const waitMore = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };

  it('«started» alone moves nothing: until the server says the agent runs the button stays «starting» and the screen stays; the moment it does, the conversation opens', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    expect(byId('onboarding-phone-standing')).toBeNull(); // idle: no spinner
    await press(byId('onboarding-phone-start-go')); // the Mac says done; the server does not say «runs» yet
    expect(assigned).toEqual([]);
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('onboarding-phone-start-go')?.textContent).toBe('시작하는 중이에요…');
    expect(byId('onboarding-phone-standing')).not.toBeNull(); // waiting for the server: one small spinner in the button (Yuna) — the same shape as the landing's
    expect(byId('onboarding-phone-connecting')).toBeNull(); // within the limit: no line yet
    expect(byId('onboarding-phone-open-started-chat')).toBeNull(); // and no way-in button yet
    world.stand = true; // the session stands
    await waitMore(2100);
    expect(assigned).toEqual([FIRST]);
  });

  it('the session does not stand within the limit → «Mac에서 시작됐어요 · 연결을 기다리는 중» + the screen is free again (the way out is on the page · nothing moved); a later press is the usual one', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    await waitMore(31_000);
    expect(assigned).toEqual([]);
    expect(byId('onboarding-phone-connecting')?.textContent).toBe('Mac에서 시작됐어요 — 연결을 기다리고 있어요');
    expect(byId('onboarding-phone-connecting')?.getAttribute('role')).toBe('status');
    expect(byId('onboarding-phone-connecting')?.className).toContain('break-keep');
    expect(byId('onboarding-phone-standing')).toBeNull(); // the wait is over: no spinner
    // no dead end (PO): beside the line, the existing word [대화 열기] goes to the conversation with the started agent
    expect(byId('onboarding-phone-open-started-chat')?.textContent).toBe('대화 열기');
    expect(byId('onboarding-phone-open-started-chat')?.getAttribute('href')).toBe(FIRST);
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false);
    expect(byId('onboarding-phone-result')).toBeNull(); // not a refusal
  });

  it('in English the same shape: «Started on the Mac — waiting for it to connect» and [Open chat]', async () => {
    world.stand = false;
    await screen({ locale: 'en' });
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    await waitMore(31_000);
    expect(byId('onboarding-phone-connecting')?.textContent).toBe('Started on the Mac — waiting for it to connect');
    expect(byId('onboarding-phone-open-started-chat')?.getAttribute('href')).toBe(FIRST);
  });

  it('a way out pressed while it waits: nothing moves the page afterwards, the screen draws no «waiting» line, and a press of [시작] on the page that is on its way out starts nothing', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go')); // waiting for the session
    const reads = () => calls.filter((c) => c.url.startsWith('/api/desktop/startable')).length;
    markLeaving(); // the person pressed [오늘로 가기] · [대시보드로] (their own handler goes on — it may still wait for an auth refresh)
    const before = reads();
    world.stand = true;
    await waitMore(2100);
    expect(assigned).toEqual([]);
    expect(reads()).toBe(before); // the wait stopped looking
    expect(byId('onboarding-phone-connecting')).toBeNull(); // and does not claim «waiting to connect» for a person who is leaving
    const signs = phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length;
    await press(byId('onboarding-phone-start-go')); // the page is on its way out: a new flow must not begin under the pending move
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length).toBe(signs);
    expect(assigned).toEqual([]);
  });

  it('the screen\'s own first read, still out when the way out is pressed, asks for nothing more and draws nothing', async () => {
    let answer: (a: Record<string, unknown>) => void = () => undefined;
    phoneCall.mockImplementation(() => new Promise((r) => { answer = r as (a: Record<string, unknown>) => void; }));
    await screen();
    markLeaving(); // the onboarding's finish waits for an auth refresh before it unmounts
    answer(keyAnswer);
    await flush();
    expect(calls.map((c) => c.url)).toEqual([]); // no device list, no startable read
    expect(byId('onboarding-phone-start')).toBeNull(); // and nothing was drawn from a read that was given up
    expect(text()).not.toContain('불러오지 못했어요'); // not even the «read failed» card of a read that was only given up
  });

  it('a page on its way out does not follow a [결과 확인] either (no poll, no new post)', async () => {
    world.post = json({ error: { code: 'INTERNAL_ERROR' } }, 500); // the press ends «unknown»: [결과 확인] is offered
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    expect(byId('onboarding-phone-check')).not.toBeNull();
    markLeaving();
    const before = calls.length;
    await press(byId('onboarding-phone-check'));
    expect(calls.length).toBe(before);
    expect(assigned).toEqual([]);
  });

  // ---- the one-stop-signal rule (PO 10-19: rounds 3 · 4 · 5 were the same family): what a STOPPED flow gets back later does nothing
  it('a way out while the command is being followed: the poll stops (no more /desktop-commands requests), nothing moves', async () => {
    world.poll = json({ state: 'running', result_code: null }); // no end: the press keeps following the command
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    await waitMore(3200);
    const polls = () => calls.filter((c) => c.url.includes('/desktop-commands/')).length;
    expect(polls()).toBeGreaterThan(0);
    markLeaving();
    const before = polls();
    await waitMore(10_000);
    expect(polls()).toBe(before);
    expect(assigned).toEqual([]);
  });

  it('a way out while the start is still out: a late `remote_off` neither switches the screen nor starts another read', async () => {
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    world.post = json({ error: { code: 'remote_control_off' } }, 409);
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    markLeaving();
    const keyReads = () => phoneCall.mock.calls.filter((c) => c[0] === 'device.key.info').length;
    const before = keyReads();
    release();
    await flush(); await settle();
    expect(byId('onboarding-phone-off')).toBeNull(); // not «remote control is off»
    expect(keyReads()).toBe(before); // and no new discovery read was scheduled
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false); // the screen is only freed
  });

  it('a stopped flow\'s late refusal draws no result line (a way out, then the post answers «computer unreachable»)', async () => {
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    world.post = json({ error: { code: 'device_unreachable' } }, 409);
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    markLeaving();
    release();
    await flush(); await settle();
    expect(byId('onboarding-phone-result')).toBeNull();
    expect(text()).not.toContain('닿지 않아요');
  });

  it('a way out while the OS prompt is up: nothing is posted for the stopped flow', async () => {
    let signed: (a: Record<string, unknown>) => void = () => undefined;
    phoneCall.mockImplementation((type: string) => (type === 'device.key.info' ? Promise.resolve(keyAnswer) : new Promise((r) => { signed = r as (a: Record<string, unknown>) => void; })));
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    markLeaving();
    signed(signAnswer);
    await flush(); await settle();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('the page restored from the back-forward cache is not left «starting» (busy · spinner) and its way-out window is over', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go')); // waiting for the session: busy with the spinner
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(true);
    markLeaving(); // …and the page moved on (a way out) — then the browser's back restores this very page
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
    await flush();
    expect(isLeaving()).toBe(false);
    // the screen read itself again (a read a way out stopped would have left it «reading» for good): it is the idle start card, not «starting»
    expect(byId('onboarding-phone-start-go')?.textContent).toBe('시작');
    expect(byId('onboarding-phone-standing')).toBeNull();
    const reads = calls.filter((c) => c.url.startsWith('/api/desktop/startable')).length;
    await act(async () => { window.dispatchEvent(new Event('pageshow')); }); // a normal show (not restored) changes nothing
    await flush();
    expect(calls.filter((c) => c.url.startsWith('/api/desktop/startable')).length).toBe(reads);
  });

  it('the way-out window is released by the module itself on a restored page (Mirko · 5166): markLeaving → pageshow(persisted) → not leaving, and a screen mounted after it draws and works', async () => {
    markLeaving();
    expect(isLeaving()).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })); // a normal show keeps it
    expect(isLeaving()).toBe(true);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(isLeaving()).toBe(false);
    await screen(); // mounted AFTER the restore (no screen was there to release it)
    expect(byId('onboarding-phone-start')).not.toBeNull();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    expect(assigned.length).toBe(1);
  });

  it('PO 10-19: a start signed at the OS prompt is posted even if a way out is pressed right after; only the waiting · poll · move stop (post 1 · poll 0 · move 0)', async () => {
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush(); // the signature came back, the post is out (held)
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
    markLeaving();
    release();
    await flush(); await settle();
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/desktop-commands/')).length).toBe(0);
    expect(assigned).toEqual([]);
  });

  it('a late «retry» / «turned on» of a page on its way out reads nothing new', async () => {
    keyAnswer = { id: 'k', ok: false, code: 'failed' }; // the first read fails: the retry card
    await screen();
    expect(byId('onboarding-phone-retry') ?? container.querySelector('button')).not.toBeNull();
    markLeaving();
    const keyReads = () => phoneCall.mock.calls.filter((c) => c[0] === 'device.key.info').length;
    const before = keyReads();
    await press(container.querySelector('button')); // the retry press lands after the way out
    expect(keyReads()).toBe(before);
  });

  it('[결과 확인] is a flow too: a way out while it follows the command stops the poll', async () => {
    world.post = json({ error: { code: 'INTERNAL_ERROR' } }, 500); // the press ends «unknown»
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    world.post = json({ command_id: CMD, state: 'queued' }, 201);
    world.poll = json({ state: 'running', result_code: null }); // no end
    await act(async () => { (byId('onboarding-phone-check') as HTMLElement).click(); });
    await flush();
    await waitMore(3200);
    const polls = () => calls.filter((c) => c.url.includes('/desktop-commands/')).length;
    expect(polls()).toBeGreaterThan(0);
    markLeaving();
    const before = polls();
    await waitMore(10_000);
    expect(polls()).toBe(before);
    expect(assigned).toEqual([]);
  });

  it('a screen that is gone leaves no flow behind (the module\'s set does not grow with every mount) — a press still out · a read still out', async () => {
    const base = openFlows();
    let answer: (a: Record<string, unknown>) => void = () => undefined;
    phoneCall.mockImplementation(() => new Promise((r) => { answer = r as (a: Record<string, unknown>) => void; })); // the first read never comes back
    await screen();
    expect(openFlows()).toBe(base + 1); // the screen's own read
    await act(async () => { root.unmount(); });
    expect(openFlows()).toBe(base);
    answer(keyAnswer);
    await flush();
    root = createRoot(container);
    // a press that is out when the screen goes
    phoneCall.mockReset(); phoneCall.mockImplementation(async (type: string) => (type === 'device.key.info' ? keyAnswer : signAnswer));
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    expect(openFlows()).toBe(base + 1); // the press (the screen's own read is over)
    await act(async () => { root.unmount(); });
    expect(openFlows()).toBe(base);
    release();
    await flush();
    root = createRoot(container);
  });

  it('two reads overlap (a restored page reads again while the first is still out): the first one answering late draws nothing over the second', async () => {
    const answers: Array<(a: Record<string, unknown>) => void> = [];
    phoneCall.mockImplementation((type: string) => (type === 'device.key.info' ? new Promise((r) => { answers.push(r as (a: Record<string, unknown>) => void); }) : Promise.resolve(signAnswer)));
    await screen(); // read 1 is out (the bridge has not answered)
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); }); // read 2 begins
    expect(answers.length).toBe(2);
    answers[1](keyAnswer); // the second answers: the usual start card
    await flush();
    expect(byId('onboarding-phone-start')).not.toBeNull();
    answers[0]({ id: 'k', ok: true, public_key: 'PK', key_number: '000 000' }); // the first answers late with a key the server does not list → «no Mac»
    await flush();
    expect(byId('onboarding-phone-no-mac')).toBeNull(); // and did not draw over the second
    expect(byId('onboarding-phone-start')).not.toBeNull();
  });

  it('the way out is one navigation however often it is tapped (the onboarding\'s finish runs once)', async () => {
    const onFinish = vi.fn();
    await renderIn(<FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onFinish={onFinish} />);
    await press(byId('onboarding-first-finish'));
    await press(byId('onboarding-first-finish'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('the onboarding\'s [오늘로 가기] marks the page as being left, then runs its own finish', async () => {
    const onFinish = vi.fn();
    await renderIn(<FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onFinish={onFinish} />);
    expect(isLeaving()).toBe(false);
    await press(byId('onboarding-first-finish'));
    expect(isLeaving()).toBe(true);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('the discovery read of a screen that is gone asks for nothing more: the bridge answers after the screen left → no device list · no startable read', async () => {
    let answer: (a: Record<string, unknown>) => void = () => undefined;
    phoneCall.mockImplementation(() => new Promise((r) => { answer = r as (a: Record<string, unknown>) => void; }));
    await screen();
    await act(async () => { root.unmount(); });
    answer(keyAnswer);
    await flush();
    expect(calls.map((c) => c.url)).toEqual([]);
    root = createRoot(container); // afterEach unmounts it
  });

  it('the screen left while it waits → nothing moves afterwards (a late «runs» goes nowhere)', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    await act(async () => { root.unmount(); });
    const reads = () => calls.filter((c) => c.url.startsWith('/api/desktop/startable')).length;
    const before = reads();
    world.stand = true;
    await waitMore(5000);
    expect(assigned).toEqual([]);
    expect(reads()).toBe(before); // and it asks no more (a left screen does not keep reading for half a minute)
    root = createRoot(container); // afterEach unmounts it
  });

  it('the conversation opens in the project the start was made in — a project other than the first one (the route would use the session\'s default otherwise)', async () => {
    await screen();
    await pickFromSheet('onboarding-phone-project', '정산'); // the second offered project
    await press(byId('onboarding-phone-start-go'));
    expect(assigned).toEqual([`/onboarding/first-instruction?agent=${AGENT}&project=${PROJECT2}`]);
  });

  it('two presses in the same tick sign and start ONCE (the second sees the old `busy` — a ref stops it)', async () => {
    world.stand = false;
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    const go = byId('onboarding-phone-start-go') as HTMLButtonElement;
    await act(async () => { go.click(); go.click(); });
    await flush(); await settle();
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').length).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
  });

  it('the spinner is for the wait for the session only: not while the start is out (signing · posting), and not left over for a later press', async () => {
    world.stand = false;
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((r) => { release = r; });
    await screen();
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    expect(byId('onboarding-phone-start-go')?.textContent).toBe('시작하는 중이에요…'); // busy …
    expect(byId('onboarding-phone-standing')).toBeNull(); // … but nothing is being waited for yet: no spinner
    release();
    await flush(); await settle();
    expect(byId('onboarding-phone-standing')).not.toBeNull(); // the Mac said done: now the wait
    await waitMore(31_000);
    expect(byId('onboarding-phone-connecting')).not.toBeNull();
    // a later press: while ITS start is out there is no spinner again (the wait of the first press is over)
    world.hold = new Promise<void>((r) => { release = r; });
    await act(async () => { (byId('onboarding-phone-start-go') as HTMLElement).click(); });
    await flush();
    expect(byId('onboarding-phone-standing')).toBeNull();
    release();
    await flush();
  });

  it('several agents: the conversation is the one with the agent that was picked and started — not the first', async () => {
    const AGENT_B = '22222222-3333-4444-8555-777777777777';
    world.startable = { remote_control: true, computers: [computer({ agents: [
      { agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }] },
      { agent_member_id: AGENT_B, name: '정산 담당', can_command: true, projects: [{ project_id: PROJECT2, name: '정산' }] },
    ] })] };
    await screen();
    await pickFromSheet('onboarding-phone-agent', '정산 담당');
    await pickFromSheet('onboarding-phone-project', '정산');
    await press(byId('onboarding-phone-start-go'));
    expect(assigned).toEqual([`/onboarding/first-instruction?agent=${AGENT_B}&project=${PROJECT2}`]);
  });

  it('inside the onboarding\'s first screen (the phone app) the same start goes the same way — the one behaviour for both places', async () => {
    await renderIn(<FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onFinish={() => undefined} />);
    await pickFromSheet('onboarding-phone-project', '결제 개편');
    await press(byId('onboarding-phone-start-go'));
    expect(assigned).toEqual([FIRST]);
  });
});


describe('[4734] one computer, its setups\' agents together — a start names the agent\'s OWN setup', () => {
  const COMPUTER_ID = '99999999-9999-4999-8999-999999999999';
  const SETUP2 = '11111111-2222-4333-8444-666666666666';
  // the server lists one entry per SETUP (the phone shell finds an entry by `setup_id`); two setups of one Mac share a computer_id
  const sharedMac = () => ({ remote_control: true, computers: [
    computer({ computer_id: COMPUTER_ID, agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }] }] }),
    computer({ computer_id: COMPUTER_ID, setup_id: SETUP2, agents: [{ agent_member_id: AGENT2, name: '문서 담당', can_command: true, projects: [{ project_id: PROJECT2, name: '정산' }] }] }),
  ] });

  it('two setups of one computer are ONE card (no «computer» picker), with both setups\' agents in the agent sheet', async () => {
    world.startable = sharedMac();
    await screen();
    expect(byId('onboarding-phone-computer')).toBeNull(); // reverted (one card per setup) → a computer picker with two «윤재의 맥북»
    await press(byId('onboarding-phone-agent'));
    const names = Array.from(container.querySelectorAll('[data-testid="onboarding-phone-sheet-row"]')).map((r) => r.textContent);
    expect(names).toEqual(expect.arrayContaining(['결제 담당', '문서 담당']));
    expect(names).toHaveLength(2);
  });

  it('starting the SECOND setup\'s agent signs for THAT setup (the shell finds the entry by it) — never for the card\'s first setup', async () => {
    world.startable = sharedMac();
    await screen();
    await pickFromSheet('onboarding-phone-agent', '문서 담당');
    await pickFromSheet('onboarding-phone-project', '정산');
    await press(byId('onboarding-phone-start-go'));
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'start_session', setup_id: SETUP2, agent_member_id: AGENT2, project_id: PROJECT2 });
    expect(phoneCall).not.toHaveBeenCalledWith('command.sign', expect.objectContaining({ agent_member_id: AGENT2, setup_id: SETUP }));
  });

  it('an older server (no computer_id) keeps one entry per setup, exactly as before', async () => {
    world.startable = { remote_control: true, computers: [computer(), computer({ setup_id: SETUP2, device_name: '사무실 맥' })] };
    await screen();
    expect(byId('onboarding-phone-computer')).not.toBeNull(); // two computers to choose between, as before
  });
});
