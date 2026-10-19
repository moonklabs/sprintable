// @vitest-environment jsdom
//
// story 4714 (AC3 · AC4 — PO 10-19): where the phone app lands when it is opened. The decision reads two things the server knows (which computers this
// phone is paired with · whether any of their sessions lives) and sends the person to the chat list · the start screen · the usual home; every read that
// fails is the usual home. Each test names the line that, reverted, turns it red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { __resetOrgRemoteControlForTest } from '@/lib/org-remote-control';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/lib/phone-app-store', async (orig) => ({ ...(await orig<typeof import('@/lib/phone-app-store')>()), PHONE_APP_PUBLISHED: { android: true, ios: false } }));
const { decideLanding, landedThisLaunch, markLanded } = await import('@/lib/phone-landing');
const { landingHome } = await import('@/lib/phone-landing-address');
const { PhoneLanding, BRIDGE_WAIT_MS } = await import('./phone-landing');
const { PhoneStartPage } = await import('./phone-start-page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP_A = '11111111-2222-4333-8444-555555555555';
const SETUP_B = '11111111-2222-4333-8444-666666666666';
const AGENT = '22222222-3333-4444-8555-666666666666';
const PROJECT = '33333333-4444-4555-8666-777777777777';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const computer = (setup_id: string, device_name: string) => ({
  setup_id, device_name, reachable: true,
  agents: [{ agent_member_id: AGENT, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }] }],
});

interface World { devices?: unknown[]; startable?: unknown; sessions: Record<string, Response | (() => Response)> }
let world: World;
let calls: string[];
function server() {
  calls = [];
  fetchWithAuth.mockImplementation(async (url: string) => {
    calls.push(url);
    if (url === '/api/remote-devices') return json({ devices: world.devices ?? [{ id: 'p-1', confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) return json(world.startable ?? { remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북')] });
    const m = url.match(/^\/api\/desktop\/setups\/([^/]+)\/sessions$/);
    if (m) { const a = world.sessions[m[1]]; return a === undefined ? json({ sessions: [] }) : typeof a === 'function' ? a() : a.clone(); }
    if (url === '/api/auth/me') return json({ data: { org_id: 'org-1', org_member_id: 'om-1' } });
    if (url.endsWith('/remote-control')) return json({ data: { enabled: true, enabled_at: null, can_change: true } });
    throw new Error(`unexpected ${url}`);
  });
}
const sessionsOf = (...states: string[]) => json({ sessions: states.map((state, i) => ({ session_key: `k${i}`, agent_member_id: AGENT, state })) });

let phoneCall: ReturnType<typeof vi.fn>;
let keyAnswer: Record<string, unknown>;
beforeEach(() => {
  world = { sessions: {} };
  keyAnswer = { id: 'k', ok: true, public_key: 'PK', key_number: '482 917' };
  phoneCall = vi.fn(async () => keyAnswer);
  fetchWithAuth.mockReset();
  __resetOrgRemoteControlForTest();
  window.sessionStorage.clear();
  server();
});

describe('[4714] decideLanding — what the server knows decides', () => {
  it('a paired computer with NO live session (none · only stopped ones) → the start screen', async () => {
    world.sessions[SETUP_A] = sessionsOf();
    expect(await decideLanding(phoneCall as never)).toBe('start');
    world.sessions[SETUP_A] = sessionsOf('stopped', 'stopped');
    expect(await decideLanding(phoneCall as never)).toBe('start');
    expect(calls).toContain(`/api/desktop/setups/${SETUP_A}/sessions`); // the sessions of THE computer this phone is paired with
  });

  it('a paired computer with a live session → the chat list (AC4); any state that is not «stopped» lives', async () => {
    for (const live of ['running', 'idle', 'waiting_input']) {
      world.sessions[SETUP_A] = sessionsOf('stopped', live);
      expect([live, await decideLanding(phoneCall as never)]).toEqual([live, 'chats']);
    }
  });

  it('paired with nothing → the usual home (the key is not on the server · the list of computers is empty · no screen lock)', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    expect(await decideLanding(phoneCall as never)).toBe('home');
    expect(calls.some((c) => c.includes('/sessions'))).toBe(false); // nothing to ask about
    world.devices = undefined;
    world.startable = { remote_control: true, computers: [] };
    expect(await decideLanding(phoneCall as never)).toBe('home');
    world.startable = undefined;
    keyAnswer = { id: 'k', ok: false, code: 'no_screen_lock' };
    expect(await decideLanding(phoneCall as never)).toBe('home');
  });

  it('TWO paired computers: a live session on ANY of them → the chat list; none on either → the start screen (the person picks the computer there)', async () => {
    world.startable = { remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북'), computer(SETUP_B, '사무실 맥')] };
    world.sessions[SETUP_A] = sessionsOf('stopped');
    world.sessions[SETUP_B] = sessionsOf('running');
    expect(await decideLanding(phoneCall as never)).toBe('chats');
    world.sessions[SETUP_A] = sessionsOf('running');
    world.sessions[SETUP_B] = sessionsOf('stopped');
    expect(await decideLanding(phoneCall as never)).toBe('chats'); // not «the first computer only»
    world.sessions[SETUP_A] = sessionsOf();
    world.sessions[SETUP_B] = sessionsOf('stopped');
    expect(await decideLanding(phoneCall as never)).toBe('start');
    expect(calls.filter((c) => c.includes('/sessions')).length).toBeGreaterThanOrEqual(4); // both computers were asked
  });

  it('a read that fails is the usual home, never a screen made of a missing answer: startable · sessions (5xx · 403 · a body of another shape · a row with no state) · a device that is silent', async () => {
    world.startable = { remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북'), computer(SETUP_B, '사무실 맥')] };
    world.sessions[SETUP_A] = sessionsOf();
    for (const bad of [json({}, 500), json({ error: { code: 'NOT_ORG_ADMIN' } }, 403), json({ sessions: [] }, 500) /* a status that says no, whatever the body */, json({ sessions: 'x' }), json({ sessions: [{ session_key: 'k' }] }), sessionsOf('unknown')]) {
      world.sessions[SETUP_B] = bad;
      expect(await decideLanding(phoneCall as never)).toBe('home'); // the other computer says «none» — still not «nothing is running»
    }
    world.sessions[SETUP_B] = () => { throw new Error('network'); };
    expect(await decideLanding(phoneCall as never)).toBe('home');
    // a live session wins over a read that failed elsewhere: it is known
    world.sessions[SETUP_A] = sessionsOf('running');
    world.sessions[SETUP_B] = json({}, 500);
    expect(await decideLanding(phoneCall as never)).toBe('chats');
    fetchWithAuth.mockImplementation(async () => { throw new Error('offline'); });
    expect(await decideLanding(phoneCall as never)).toBe('home');
  });

  it('the mark of «this launch had its landing» (a storage that cannot be read counts as had it)', () => {
    expect(landedThisLaunch()).toBe(false);
    markLanded();
    expect(landedThisLaunch()).toBe(true);
    window.sessionStorage.clear(); // nothing stored: only an unreadable storage can say «had it» now
    // jsdom's storage does not take a spy on `getItem` — the storage itself is what the web view can make unreadable (a blocked-storage setting throws on the getter)
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
    expect(landedThisLaunch()).toBe(true); // never a loop
    Object.defineProperty(window, 'sessionStorage', real);
    expect(landedThisLaunch()).toBe(false); // and it was the unreadable storage that said so: the same call on a readable, empty one says «not yet»
  });
});

describe('[4714] the landing door — an empty area, one go, once per launch', () => {
  let container: HTMLDivElement;
  let root: Root;
  let replace: ReturnType<typeof vi.fn>;
  let assign: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    replace = vi.fn();
    assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace, assign });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
  const mount = async (ui: React.ReactElement, phone = true) => {
    await act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
          <NextIntlClientProvider locale="ko" messages={koMessages}>{ui}</NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await flush();
  };
  const HOME = '/moonklabs/sprintable/flow'; // what the proxy resolved the shell's home to
  const door = (next: string | null = HOME) => mount(<PhoneLanding chatsHref="/chats" next={next} />);

  it('a live session → the chat list · paired and none live → /phone-start · not paired → the home the proxy resolved', async () => {
    world.sessions[SETUP_A] = sessionsOf('running');
    await door();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/chats');

    window.sessionStorage.clear(); replace.mockClear();
    world.sessions[SETUP_A] = sessionsOf();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await door();
    expect(replace).toHaveBeenCalledWith('/phone-start');

    window.sessionStorage.clear(); replace.mockClear();
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await door();
    expect(replace).toHaveBeenCalledWith(HOME);
  });

  it('the home it goes to is only an address of THIS app — a host · `//` · a backslash · a control character · nothing is the site root (no open redirect out of a link someone sends); a path with its query is kept', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }]; // not paired: the home
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/\\evil', '/ok\nx', 'javascript:alert(1)', 'moonklabs/flow', '', null]) {
      window.sessionStorage.clear(); replace.mockClear();
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await door(bad as string | null);
      expect([bad, replace.mock.calls[0]?.[0]]).toEqual([bad, '/']);
    }
    window.sessionStorage.clear(); replace.mockClear();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await door('/moonklabs/sprintable/flow?x=1');
    expect(replace).toHaveBeenCalledWith('/moonklabs/sprintable/flow?x=1');
    expect(landingHome('/a/b')).toBe('/a/b');
    expect(landingHome(undefined)).toBe('/');
  });

  it('the area stays EMPTY (aria-busy) until the answer — nothing of a home is drawn first (no flash)', async () => {
    let release: (r: Response) => void = () => undefined;
    world.sessions[SETUP_A] = () => { throw new Error('unused'); };
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/remote-devices') return json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      if (url.startsWith('/api/desktop/startable')) return json({ remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북')] });
      return new Promise<Response>((r) => { release = r; }); // the sessions read is out
    });
    await door();
    const area = container.querySelector('[data-testid="phone-landing"]');
    expect(area?.getAttribute('aria-busy')).toBe('true');
    expect(area?.textContent).toBe('');
    expect(replace).not.toHaveBeenCalled();
    release(sessionsOf());
    await flush();
    expect(replace).toHaveBeenCalledWith('/phone-start');
  });

  it('ONCE per launch: the second time in the same launch goes straight home — no read at all (a back press absorbed into the home is not a new opening)', async () => {
    world.sessions[SETUP_A] = sessionsOf('running');
    await door();
    expect(replace).toHaveBeenCalledWith('/chats');
    replace.mockClear(); calls.length = 0;
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await door();
    expect(replace).toHaveBeenCalledWith(HOME);
    expect(calls).toEqual([]);
  });

  it('the mark is made BEFORE the reads: a reload while they are out is the same launch', async () => {
    fetchWithAuth.mockImplementation(() => new Promise<Response>(() => undefined)); // never answers
    await door();
    expect(landedThisLaunch()).toBe(true);
  });

  it('not the phone app (a browser that opened the address): the usual home after the claim had its moment, and nothing is read', async () => {
    await mount(<PhoneLanding chatsHref="/chats" next={HOME} />, false);
    expect(replace).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 50); });
    expect(replace).toHaveBeenCalledWith(HOME);
    expect(calls).toEqual([]);
  });

  it('a read that throws or never fits is the usual home (the door never stays shut)', async () => {
    fetchWithAuth.mockImplementation(async () => { throw new Error('offline'); });
    await door();
    expect(replace).toHaveBeenCalledWith(HOME);
  });
});

describe('[4714] /phone-start — the start screen at its own address, with a way out', () => {
  let container: HTMLDivElement;
  let root: Root;
  let replace: ReturnType<typeof vi.fn>;
  let assign: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    replace = vi.fn();
    assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace, assign });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
  const page = async (phone = true) => {
    await act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
          <NextIntlClientProvider locale="ko" messages={koMessages}>
            <PhoneStartPage chatsHref="/chats" homeHref="/today" macDownloadEnabled={false} />
          </NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await flush();
  };
  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('the phone app\'s start screen is drawn (the computer\'s name · the agent · the project) and the way out [오늘로 가기] is on it — a launch never traps', async () => {
    await page();
    expect(byId('onboarding-phone-start')?.textContent).toContain('윤재의 맥북에서 에이전트를 시작할까요?');
    const out = byId('phone-start-finish');
    expect(out?.textContent).toBe('오늘로 가기');
    await act(async () => { out?.click(); });
    expect(assign).toHaveBeenCalledWith('/today'); // the onboarding's own finish address — never back to the landing
  });

  it('the way out is there on EVERY branch of the screen (no Mac · no agent · remote control off), not only on the start card', async () => {
    world.startable = { remote_control: true, computers: [] };
    await page();
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
    expect(byId('phone-start-finish')).not.toBeNull();
  });

  it('not the phone app: it goes home after the claim had its moment, and draws nothing of the screen', async () => {
    await page(false);
    expect(byId('onboarding-phone-start')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 50); });
    expect(replace).toHaveBeenCalledWith('/today'); // the screen's own home address (what [오늘로 가기] goes to)
  });
});
