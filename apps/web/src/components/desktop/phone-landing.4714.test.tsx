// @vitest-environment jsdom
//
// story 4714 (AC3 · AC4 — PO 10-19): where the phone app lands when it is opened. The decision reads what the server says in the one read the start screen
// already makes (this phone's paired computers · for each agent whether it runs) and sends the person to the chat list · the start screen · the usual home;
// every read that fails, and a computer that was not heard from, is the usual home. Each test names the line that, reverted, turns it red.
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
const { PhoneLanding, BRIDGE_WAIT_MS, LANDING_MAX_MS, SPINNER_AFTER_MS } = await import('./phone-landing');
const { PhoneStartPage } = await import('./phone-start-page');
const { isLeaving, clearLeaving } = await import('@/lib/phone-start');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP_A = '11111111-2222-4333-8444-555555555555';
const SETUP_B = '11111111-2222-4333-8444-666666666666';
const AGENT = '22222222-3333-4444-8555-666666666666';
const AGENT2 = '22222222-3333-4444-8555-777777777777';
const PROJECT = '33333333-4444-4555-8666-777777777777';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** a paired computer with one agent the person may command; `running` is the server's word on it (true · false · null = the computer was not heard from · undefined = a server that does not say) */
const computer = (setup_id: string, device_name: string, running: boolean | null | undefined, agentId = AGENT) => ({
  setup_id, device_name, reachable: true,
  agents: [{ agent_member_id: agentId, name: '결제 담당', can_command: true, projects: [{ project_id: PROJECT, name: '결제 개편' }], ...(running === undefined ? {} : { running }) }],
});

interface World { devices?: unknown[]; startable?: unknown }
let world: World;
let calls: string[];
function server() {
  calls = [];
  fetchWithAuth.mockImplementation(async (url: string) => {
    calls.push(url);
    if (url === '/api/remote-devices') return json({ devices: world.devices ?? [{ id: 'p-1', confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) return json(world.startable ?? { remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북', false)] });
    if (url === '/api/auth/me') return json({ data: { org_id: 'org-1', org_member_id: 'om-1' } });
    if (url.endsWith('/remote-control')) return json({ data: { enabled: true, enabled_at: null, can_change: true } });
    throw new Error(`unexpected ${url}`); // the device's session list is NOT read here (owners and admins only — a plain member who owns an agent has a phone too): the startable read says it
  });
}
const startable = (...computers: unknown[]) => { world.startable = { remote_control: true, computers }; };

let phoneCall: ReturnType<typeof vi.fn>;
let keyAnswer: Record<string, unknown>;
beforeEach(() => {
  world = {};
  keyAnswer = { id: 'k', ok: true, public_key: 'PK', key_number: '482 917' };
  phoneCall = vi.fn(async () => keyAnswer);
  fetchWithAuth.mockReset();
  __resetOrgRemoteControlForTest();
  window.sessionStorage.clear();
  server();
});

describe('[4714] decideLanding — what the server says decides', () => {
  it('a paired computer whose agent does not run → the start screen; one read says it (no list of sessions is asked)', async () => {
    expect(await decideLanding(phoneCall as never)).toBe('start');
    expect(calls.filter((c) => c.includes('/sessions'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('/api/desktop/startable')).length).toBe(1);
  });

  it('an agent that runs on a paired computer → the chat list (AC4)', async () => {
    startable(computer(SETUP_A, '윤재의 맥북', true));
    expect(await decideLanding(phoneCall as never)).toBe('chats');
  });

  it('paired with nothing → the usual home (the key is not on the server · the list of computers is empty · no screen lock)', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    expect(await decideLanding(phoneCall as never)).toBe('home');
    expect(calls.some((c) => c.startsWith('/api/desktop/startable'))).toBe(false); // nothing to ask about
    world.devices = undefined;
    startable();
    expect(await decideLanding(phoneCall as never)).toBe('home');
    world.startable = undefined;
    keyAnswer = { id: 'k', ok: false, code: 'no_screen_lock' };
    expect(await decideLanding(phoneCall as never)).toBe('home');
  });

  it('TWO paired computers: an agent that runs on ANY of them → the chat list (not «the first computer only»); none runs on either → the start screen (the person picks the computer there)', async () => {
    startable(computer(SETUP_A, '윤재의 맥북', false), computer(SETUP_B, '사무실 맥', true, AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('chats');
    startable(computer(SETUP_A, '윤재의 맥북', true), computer(SETUP_B, '사무실 맥', false, AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('chats');
    startable(computer(SETUP_A, '윤재의 맥북', false), computer(SETUP_B, '사무실 맥', false, AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('start');
  });

  it('what is not known is the usual home: an agent on a heard-from computer the server cannot tell about (`running: null`) or a server that does not say; a known live agent still wins over it', async () => {
    startable(computer(SETUP_A, '윤재의 맥북', false), computer(SETUP_B, '사무실 맥', null, AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('home');
    startable(computer(SETUP_A, '윤재의 맥북', undefined)); // an older server: no word — never read as «not running»
    expect(await decideLanding(phoneCall as never)).toBe('home');
    startable(computer(SETUP_A, '윤재의 맥북', 'true' as unknown as boolean)); // a word that is not a boolean is no word
    expect(await decideLanding(phoneCall as never)).toBe('home');
    startable(computer(SETUP_A, '윤재의 맥북', true), computer(SETUP_B, '사무실 맥', null, AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('chats');
  });

  it('a computer that was not heard from is left out: an old silent Mac beside a working one does not hold the person at the usual home (wheel 2 · 10-19); with no computer heard from → the usual home', async () => {
    const silent = (setup_id: string, name: string, agentId: string) => ({ ...computer(setup_id, name, null, agentId), reachable: false });
    startable(computer(SETUP_A, '새 맥', false), silent(SETUP_B, '옛 맥', AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('start');
    startable(silent(SETUP_B, '옛 맥', AGENT2), computer(SETUP_A, '새 맥', true));
    expect(await decideLanding(phoneCall as never)).toBe('chats');
    startable(silent(SETUP_A, '옛 맥', AGENT), silent(SETUP_B, '옛 맥 2', AGENT2));
    expect(await decideLanding(phoneCall as never)).toBe('home');
    // a silent computer is out even when its word says «runs» (it cannot be told to do anything) — the heard one decides
    startable({ ...computer(SETUP_B, '옛 맥', true, AGENT2), reachable: false }, computer(SETUP_A, '새 맥', false));
    expect(await decideLanding(phoneCall as never)).toBe('start');
  });

  it('a read that fails is the usual home, never a screen made of a missing answer (the start read · the key list · the bridge)', async () => {
    fetchWithAuth.mockImplementation(async () => { throw new Error('offline'); });
    expect(await decideLanding(phoneCall as never)).toBe('home');
    server();
    fetchWithAuth.mockImplementationOnce(async () => json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] })).mockImplementationOnce(async () => json({}, 500));
    expect(await decideLanding(phoneCall as never)).toBe('home');
    server();
    phoneCall.mockImplementation(async () => { throw new Error('bridge'); });
    expect(await decideLanding(phoneCall as never)).toBe('home');
  });
});

describe('[4714] the mark of «this launch had its landing»', () => {
  it('made once, read back; a storage that cannot be READ counts as «had it» (never a loop)', () => {
    expect(landedThisLaunch()).toBe(false);
    expect(markLanded()).toBe(true);
    expect(landedThisLaunch()).toBe(true);
    window.sessionStorage.clear(); // nothing stored: only an unreadable storage can say «had it» now
    // jsdom's storage does not take a spy on `getItem` — the storage itself is what the web view can make unreadable (a blocked-storage setting throws on the getter)
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
    expect(landedThisLaunch()).toBe(true);
    Object.defineProperty(window, 'sessionStorage', real);
    expect(landedThisLaunch()).toBe(false); // and it was the unreadable storage that said so: a readable, empty one says «not yet»
  });

  it('a storage that refuses WRITES cannot keep «once»: markLanded says false (also when the write seems to take but cannot be read back)', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
    expect(markLanded()).toBe(false);
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    expect(markLanded()).toBe(false);
    Object.defineProperty(window, 'sessionStorage', real);
  });
});

describe('[4714] landingHome — the home it goes to is only an address of THIS app, and never the landing itself', () => {
  it('a host · `//` · a backslash · a control character · not a string · no leading slash → the site root; a path with its query is kept', () => {
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/\\evil', '/ok\nx', 'javascript:alert(1)', 'moonklabs/flow', '', null, undefined]) {
      expect([bad, landingHome(bad as string | null | undefined)]).toEqual([bad, '/']);
    }
    expect(landingHome('/moonklabs/sprintable/flow')).toBe('/moonklabs/sprintable/flow');
    expect(landingHome('/moonklabs/sprintable/flow?x=1')).toBe('/moonklabs/sprintable/flow?x=1');
    expect(landingHome('/phone-start')).toBe('/phone-start'); // the start screen has its own way out: not a loop
  });

  it('the landing itself (any spelling that reaches it: query · trailing slash · case · dot segments · percent-encoding) is the site root — it would send the person round and round', () => {
    for (const loop of ['/phone-landing', '/phone-landing?next=/phone-landing', '/phone-landing/', '/PHONE-LANDING', '/x/../phone-landing', '/phone%2Dlanding', '/phone-landing%2F', '/phone-landing#x']) {
      expect([loop, landingHome(loop)]).toEqual([loop, '/']);
    }
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
  const again = async () => { window.sessionStorage.clear(); replace.mockClear(); await act(async () => { root.unmount(); }); root = createRoot(container); };

  it('an agent that runs → the chat list · paired and none runs → /phone-start · not paired → the home the proxy resolved', async () => {
    startable(computer(SETUP_A, '윤재의 맥북', true));
    await door();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/chats');

    await again();
    startable(computer(SETUP_A, '윤재의 맥북', false));
    await door();
    expect(replace).toHaveBeenCalledWith('/phone-start');

    await again();
    world.devices = [{ id: 'x', confirm_number: '000 000' }];
    await door();
    expect(replace).toHaveBeenCalledWith(HOME);
  });

  it('the home it goes to is only an address of THIS app; the landing itself is never the home (the person is not sent round and round)', async () => {
    world.devices = [{ id: 'x', confirm_number: '000 000' }]; // not paired: the home
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/phone-landing?next=/phone-landing', null]) {
      await again();
      await door(bad);
      expect([bad, replace.mock.calls[0]?.[0]]).toEqual([bad, '/']);
    }
  });

  it('the area stays EMPTY (aria-busy) until the answer — nothing of a home is drawn first (no flash)', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/remote-devices') return json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      return new Promise<Response>((r) => { release = r; }); // the startable read is out
    });
    await door();
    const area = container.querySelector('[data-testid="phone-landing"]');
    expect(area?.getAttribute('aria-busy')).toBe('true');
    expect(area?.textContent).toBe('');
    expect(replace).not.toHaveBeenCalled();
    release(json({ remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북', false)] }));
    await flush();
    expect(replace).toHaveBeenCalledWith('/phone-start');
  });

  it('the area is EMPTY for the first second (a quick answer flashes nothing) and then a small spinner says the app is working — by the common «loading» word, no new words', async () => {
    fetchWithAuth.mockImplementation(() => new Promise<Response>(() => undefined)); // the read is out
    await door();
    const area = () => container.querySelector('[data-testid="phone-landing"]');
    expect(area()?.querySelector('[data-testid="phone-landing-spinner"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(SPINNER_AFTER_MS - 100); });
    expect(area()?.querySelector('[data-testid="phone-landing-spinner"]')).toBeNull(); // not early
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const spinner = area()?.querySelector('[data-testid="phone-landing-spinner"]');
    expect(spinner?.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(area()?.getAttribute('aria-busy')).toBe('true');
    expect(SPINNER_AFTER_MS).toBe(1000);
  });

  it('the limit is four seconds (the empty area is never longer than that)', () => {
    expect(LANDING_MAX_MS).toBe(4000);
  });

  it('a read that never answers is the usual home after the limit — and a late answer does not move the person a second time', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/remote-devices') return json({ devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      return new Promise<Response>((r) => { release = r; });
    });
    await door();
    expect(replace).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(LANDING_MAX_MS - 100); });
    expect(replace).not.toHaveBeenCalled(); // the limit is not early
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(HOME);
    release(json({ remote_control: true, computers: [computer(SETUP_A, '윤재의 맥북', true)] }));
    await flush();
    expect(replace).toHaveBeenCalledTimes(1); // one move only
  });

  it('a bridge call that never answers (it can wait minutes) is stopped by the same limit', async () => {
    phoneCall.mockImplementation(() => new Promise(() => undefined));
    await door();
    await act(async () => { await vi.advanceTimersByTimeAsync(LANDING_MAX_MS + 100); });
    expect(replace).toHaveBeenCalledWith(HOME);
  });

  it('ONCE per launch: the second time in the same launch goes straight home — no read at all (a back press absorbed into the home is not a new opening)', async () => {
    startable(computer(SETUP_A, '윤재의 맥북', true));
    await door();
    expect(replace).toHaveBeenCalledWith('/chats');
    replace.mockClear(); calls.length = 0;
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await door();
    expect(replace).toHaveBeenCalledWith(HOME);
    expect(calls).toEqual([]);
  });

  it('the mark is made BEFORE the read: a reload while it is out is the same launch', async () => {
    fetchWithAuth.mockImplementation(() => new Promise<Response>(() => undefined)); // never answers
    await door();
    expect(landedThisLaunch()).toBe(true);
  });

  it('a storage that refuses the mark cannot keep «once»: the usual home, no read', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
    try {
      await door();
      expect(replace).toHaveBeenCalledWith(HOME);
      expect(calls).toEqual([]);
    } finally {
      Object.defineProperty(window, 'sessionStorage', real);
    }
  });

  it('not the phone app (a browser that opened the address): the usual home after the claim had its moment, and nothing is read', async () => {
    await mount(<PhoneLanding chatsHref="/chats" next={HOME} />, false);
    expect(replace).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 50); });
    expect(replace).toHaveBeenCalledWith(HOME);
    expect(calls).toEqual([]);
  });

  it('a read that throws is the usual home (the door never stays shut)', async () => {
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
    clearLeaving(); // the way-out window is a time: a test that pressed a way out must not leave it open for the next
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
  const page = async (phone = true, todayV3Enabled = true) => {
    await act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
          <NextIntlClientProvider locale="ko" messages={koMessages}>
            <PhoneStartPage chatsHref="/chats" homeHref={todayV3Enabled ? '/today' : '/chats'} todayV3Enabled={todayV3Enabled} macDownloadEnabled={false} />
          </NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await flush();
  };
  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('the phone app\'s start screen is drawn (the computer\'s name · the agent · the project) and the way out is on it — a launch never traps', async () => {
    await page();
    expect(byId('onboarding-phone-start')?.textContent).toContain('윤재의 맥북에서 에이전트를 시작할까요?');
    const out = byId('phone-start-finish');
    expect(out?.textContent).toBe('오늘로 가기');
    await act(async () => { out?.click(); });
    expect(assign).toHaveBeenCalledWith('/today'); // the onboarding's own finish address — never back to the landing
  });

  it('the note above the way out says «you don\'t have to do this now» — NOT the onboarding\'s «reopen from Settings › Get the desktop app» (nothing to download here, and this screen is not reopened from Settings)', async () => {
    await page();
    const later = byId('phone-start-later')?.textContent ?? '';
    expect(later).toContain('지금 하지 않아도 돼요.');
    expect(later).not.toMatch(/설정|데스크톱 앱 받기|받지 않아도/);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await page(true, false); // Today off: the same note, the button says the dashboard
    expect(byId('phone-start-later')?.textContent).toContain('지금 하지 않아도 돼요.');
    expect(byId('phone-start-later')?.textContent).not.toMatch(/설정|데스크톱 앱 받기/);
  });

  it('where «today» is off the way out says what it goes to (the dashboard · the chat list), as the onboarding\'s own finish button does', async () => {
    await page(true, false);
    expect(byId('phone-start-finish')?.textContent).toBe('대시보드로');
    await act(async () => { byId('phone-start-finish')?.click(); });
    expect(assign).toHaveBeenCalledWith('/chats');
  });

  it('pressing the way out marks the page as being left — a start still waited for must not move it a second time (the onboarding\'s finish waits for an auth refresh)', async () => {
    clearLeaving();
    await page(true, false);
    expect(isLeaving()).toBe(false);
    await act(async () => { byId('phone-start-finish')?.click(); });
    expect(isLeaving()).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    await act(async () => { byId('phone-start-finish')?.click(); }); // a second tap is not a second navigation
    expect(assign).toHaveBeenCalledTimes(1);
    clearLeaving();
  });

  it('the way out is there on EVERY branch of the screen (no Mac · no agent · remote control off), not only on the start card', async () => {
    startable();
    await page();
    expect(byId('onboarding-phone-no-mac')).not.toBeNull();
    expect(byId('phone-start-finish')).not.toBeNull();
  });

  it('not the phone app: it goes home after the claim had its moment, and draws nothing of the screen', async () => {
    await page(false);
    expect(byId('onboarding-phone-start')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 50); });
    expect(replace).toHaveBeenCalledWith('/today'); // the screen's own home address (what the way out goes to)
  });
});
