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

interface World { mail?: Response; devices?: unknown[]; startable?: unknown; remote?: unknown; post?: Response; poll?: Response; remotePut?: Response; hold?: Promise<void> }
let world: World;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
function server() {
  calls = [];
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/desktop/mac-link-mail') return world.mail ?? json({ delivered: true, email: 'me@example.test' });
    if (url === '/api/remote-devices') return json({ devices: world.devices ?? [{ id: 'p-1', confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) return json(world.startable ?? { remote_control: true, computers: [computer()] });
    if (url.endsWith('/remote-control')) return method === 'PUT' ? (world.remotePut ?? json({ data: { enabled: true, enabled_at: null, can_change: true } })) : json(world.remote ?? { data: { enabled: false, enabled_at: null, can_change: true } });
    if (url.endsWith('/desktop-start')) { if (world.hold) await world.hold; return world.post ?? json({ command_id: CMD, state: 'queued' }, 201); }
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchWithAuth.mockReset();
  __resetOrgRemoteControlForTest();
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
    const withFlag = <FirstScreen orgId="org-1" chatsHref="/chats" macDownloadEnabled orgName={null} onConnectElsewhere={() => {}} onFinish={() => {}} />;
    const withoutFlag = <FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onConnectElsewhere={() => {}} onFinish={() => {}} />;
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
    expect(byId('onboarding-phone-result')).toBeNull(); // started: no line, the chat is where it goes on
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
    expect((byId('onboarding-phone-start-go') as HTMLButtonElement).disabled).toBe(false); // it started — the screen is ready again
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
  const first = <FirstScreen orgId="org-1" chatsHref="/chats" orgName="문클랩스" onConnectElsewhere={() => {}} onFinish={() => {}} />;
  it('inside the phone app the Mac-or-not fork is not drawn: «지금은 Mac 앱만 있어요» · the web-way button · the download card are gone, the phone screen is there', async () => {
    await renderIn(first, { phone: true });
    expect(byId('onboarding-first-phone-app')).not.toBeNull();
    expect(byId('onboarding-phone-start')).not.toBeNull();
    expect(text()).not.toContain('지금은 Mac 앱만 있어요');
    expect(byId('onboarding-first-connect')).toBeNull();
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
  it('the refusals reuse the phone lines\' shape: each ends in an instruction, a started or cancelled start has no key', () => {
    expect(Object.keys(ko).filter((k) => k.startsWith('result.')).sort()).toEqual([
      'result.alreadyRunning', 'result.biometricRequired', 'result.check', 'result.failed', 'result.keyInvalidated', 'result.noFolder', 'result.noScreenLock', 'result.notPaired',
      'result.notRegistered', 'result.openChat', 'result.readFailed', 'result.remoteOff', 'result.retry', 'result.signedOut', 'result.unknown', 'result.unreachable',
    ].sort());
  });
});
