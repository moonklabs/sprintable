// @vitest-environment jsdom
//
// story 4983 (P5 · layer 5): the phone app's «프로젝트 파일» — pick a Mac and a project, walk the folders one confirmed request at a time. Every end is one line; what goes to the shell and the server
// is the computer · project · single names · a press key (no path · no name inside the envelope the web posts); the server's and the Mac's refusals each say their own words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
const { PhoneFilesPage, projectsOf, sizeText, entryOf } = await import('./phone-files-page');
const { FILE_REASONS } = await import('@/lib/phone-files');
// [P6] a shell that opens files says `file_read: 1` beside `files: 1`
const OPENS = { sealed_prompt: 1, files: 1, file_read: 1 };
const PNG_HEX = '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c636868680000030401814bd3d2100000000049454e44ae426082';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP = '11111111-2222-4333-8444-555555555555';
const SETUP2 = '11111111-2222-4333-8444-666666666666';
const CMD = '44444444-5555-4666-8777-888888888888';
const KEYID = 'p-1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ko = koMessages.phoneFiles;
const en = enMessages.phoneFiles;

const entry = (n: string, k: 'f' | 'd' | 'l' | 'o', rest: Record<string, unknown> = {}) => ({ n, k, ...rest });
const LISTS: Record<string, unknown[]> = {
  '': [entry('src', 'd', { t: 1 }), entry('README.md', 'f', { s: 1500, t: 2 }), entry('ln', 'l'), entry('sock', 'o')],
  'src': [entry('app', 'd'), entry('index.ts', 'f', { s: 42 })],
};
interface World { remote?: boolean; computers?: unknown[]; post?: Response; reason?: string; caps?: Record<string, unknown> | null; pages?: Record<string, unknown[]>; poll?: Response; read?: unknown }
let world: World;
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
let seal: Array<Record<string, unknown>>;
let container: HTMLDivElement;
let root: Root;
let phoneCall: ReturnType<typeof vi.fn>;
let sealAnswer: (args: Record<string, unknown>) => Record<string, unknown>;

const computer = (over: Record<string, unknown> = {}) => ({ setup_id: SETUP, device_name: '윤재의 맥북', reachable: true, agents: [{ agent_member_id: 'a1', name: '개발', can_command: true, projects: [{ project_id: 'proj-1', name: '결제 서비스' }, { project_id: 'proj-2', name: '문서' }] }], ...over });

function server() {
  calls = [];
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/remote-devices') return json({ devices: [{ id: KEYID, confirm_number: '482 917' }] });
    if (url.startsWith('/api/desktop/startable')) return json({ remote_control: world.remote !== false, computers: world.computers ?? [computer()] });
    if (url.endsWith('/files') && method === 'POST') return world.post ?? json({ command_id: CMD, expires_at: 'x' }, 201);
    if (url.includes('/files/')) return world.poll ? world.poll.clone() : json({ state: 'done', code: null, envelope: { v: 1, kind: 'file_result' } });
    throw new Error(`unexpected ${method} ${url}`);
  });
}

beforeEach(() => {
  world = {};
  seal = [];
  sealAnswer = (args) => ({ id: 's', ok: true, envelope: { v: 1, kind: 'file_list' }, phone_key_id: KEYID, idempotency_key: args.idempotency_key });
  phoneCall = vi.fn(async (type: string, args: Record<string, unknown> = {}) => {
    if (type === 'shell.caps') return { id: 'c', ok: true, caps: world.caps === undefined ? { sealed_prompt: 1, files: 1 } : world.caps };
    if (type === 'device.key.info') return { id: 'k', ok: true, key_number: '482 917' };
    if (type === 'files.seal') { seal.push(args); return sealAnswer(args); }
    if (type === 'files.open') {
      if (seal[seal.length - 1]!.name !== undefined) return { id: 'o', ok: true, body: world.read }; // [P6] the last request sealed was an OPEN: its answer is the read body of the world
      const dir = (seal[seal.length - 1]!.dir as string[]).join('/');
      const cursor = seal[seal.length - 1]!.cursor as string | undefined;
      if (world.reason) return { id: 'o', ok: true, body: { v: 1, kind: 'list', ok: false, reason: world.reason } };
      const page = (world.pages ?? {})[`${dir}|${cursor ?? ''}`];
      if (page) return { id: 'o', ok: true, body: { v: 1, kind: 'list', ok: true, entries: page, hidden: 0, more: cursor === undefined, ...(cursor === undefined ? { cursor: 'next' } : {}) } };
      return { id: 'o', ok: true, body: { v: 1, kind: 'list', ok: true, entries: LISTS[dir] ?? [], hidden: dir === '' ? 3 : 0, more: false } };
    }
    return { id: 'x', ok: false, code: 'bad_request' };
  });
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
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function screen({ phone = true, locale = 'ko' as 'ko' | 'en', entry }: { phone?: boolean; locale?: 'ko' | 'en'; entry?: { setupId: string; agentId: string } } = {}) {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: phone, phoneCall: phoneCall as never }}>
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages}><PhoneFilesPage homeHref="/today" entry={entry} /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await flush();
}
const text = () => container.textContent ?? '';
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); await flush(); };
const press = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click(); }); await flush(); await settle(); };
const posts = () => calls.filter((c) => c.method === 'POST');
const names = () => all('phone-files-entry').map((e) => e.textContent);

describe('[4983] outside and before', () => {
  it('outside the phone app nothing is drawn and nothing is asked', async () => {
    await screen({ phone: false });
    expect(byId('phone-files-page')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(phoneCall).not.toHaveBeenCalled();
  });
  it('a shell that does not say `files: 1` → one line, no read of the server', async () => {
    world.caps = { sealed_prompt: 1 };
    await screen();
    expect(byId('phone-files-old-app')?.textContent).toBe(ko.oldApp);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
  it('no Mac · remote control off · no project with a folder · an unreachable Mac', async () => {
    world.computers = [];
    await screen();
    expect(byId('phone-files-no-project')?.textContent).toBe(ko.noProjectOnMac);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    world.remote = false; world.computers = [computer()];
    await screen();
    expect(byId('phone-files-remote-off')?.textContent).toBe(ko.remoteOff);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    world.remote = true; world.computers = [computer({ agents: [{ agent_member_id: 'a1', name: 'x', can_command: true, projects: [] }] })];
    await screen();
    expect(byId('phone-files-no-project')?.textContent).toBe(ko.noProjectOnMac);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    world.computers = [computer({ reachable: false })];
    await screen();
    expect(byId('phone-files-unreachable')?.textContent).toBe(ko.outcome.unreachable);
    expect((byId('phone-files-project-proj-1') as HTMLButtonElement).disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });
  it('[돌아가기] goes home (the way out the start screen has)', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    await screen();
    await press(byId('phone-files-home'));
    expect(replace).toHaveBeenCalledWith('/today');
  });
  it('an answer that comes after the person pressed [프로젝트 고르기] draws nothing (the folder is gone)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const real = phoneCall.getMockImplementation() as (t: string, a?: Record<string, unknown>) => Promise<unknown>;
    phoneCall.mockImplementation(async (type: string, args: Record<string, unknown> = {}) => { if (type === 'files.open') await gate; return real(type, args); });
    await screen();
    await act(async () => { (byId('phone-files-project-proj-1') as HTMLElement).click(); });
    await flush();
    await settle();
    await press(byId('phone-files-back'));
    release(); await flush(); await settle();
    expect(byId('phone-files-folder')).toBeNull();
    expect(byId('phone-files-choose')).not.toBeNull();
  });
  it('an older answer that comes after a newer ask drew its folder (up pressed while «src» was still out) never replaces the newer one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const real = phoneCall.getMockImplementation() as (t: string, a?: Record<string, unknown>) => Promise<unknown>;
    let gated = false;
    phoneCall.mockImplementation(async (type: string, args: Record<string, unknown> = {}) => {
      if (type === 'files.open' && !gated && (seal[seal.length - 1]!.dir as string[]).join('/') === 'src') { gated = true; await gate; }
      return real(type, args);
    });
    await screen();
    await press(byId('phone-files-project-proj-1')); // the top
    await act(async () => { (container.querySelector('[data-testid="phone-files-entry"] button') as HTMLElement).click(); }); // «src» — its answer is held
    await flush(); await settle();
    await press(byId('phone-files-up')); // the top again: the newer ask
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스');
    release(); await flush(); await settle();
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스');
    expect(names()).toEqual(['src/', 'README.md1.5 KB', `ln${ko.kind.link}`, `sock${ko.kind.other}`]);
  });
  it('a failed read has its line and a retry that reads again', async () => {
    fetchWithAuth.mockImplementation(async () => new Response('x', { status: 500 }));
    await screen();
    expect(byId('phone-files-read-failed')?.textContent).toContain(ko.readFailed);
    server();
    await press(container.querySelector('[data-testid="phone-files-read-failed"] button'));
    expect(byId('phone-files-choose')).not.toBeNull();
  });
});

describe('[4983] walking a project', () => {
  it('a project\'s top: one confirmed request with NO names; entries drawn; folder · file size · link · other · hidden count', async () => {
    await screen();
    expect(all('phone-files-project-proj-1')).toHaveLength(1);
    await press(byId('phone-files-project-proj-1'));
    expect(seal).toEqual([{ setup_id: SETUP, project_id: 'proj-1', dir: [], idempotency_key: expect.any(String) }]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe(`/api/desktop/computers/${SETUP}/files`);
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스');
    expect(names()).toEqual(['src/', 'README.md1.5 KB', `ln${ko.kind.link}`, `sock${ko.kind.other}`]);
    expect(byId('phone-files-hidden')?.textContent).toBe('숨긴 항목 3개');
    expect(byId('phone-files-up')).toBeNull();
  });

  it('a folder opens with its single name appended — and the way up asks the folder above; nothing but names ever goes', async () => {
    await screen();
    await press(byId('phone-files-project-proj-1'));
    await press(container.querySelector('[data-testid="phone-files-entry"] button'));
    expect(seal[1]).toMatchObject({ dir: ['src'], project_id: 'proj-1' });
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스 › src');
    expect(names()).toEqual(['app/', 'index.ts42 B']);
    await press(container.querySelector('[data-testid="phone-files-entry"] button'));
    expect(seal[2]).toMatchObject({ dir: ['src', 'app'] });
    await press(byId('phone-files-up'));
    expect(seal[3]).toMatchObject({ dir: ['src'] });
    expect(JSON.stringify(posts().map((p) => p.body))).not.toContain('"src"'); // the envelope carries the names, the web's post does not
    for (const s of seal) expect(Object.keys(s).sort()).toEqual(['dir', 'idempotency_key', 'project_id', 'setup_id'].sort());
  });

  it('every request has its OWN press key', async () => {
    await screen();
    await press(byId('phone-files-project-proj-1'));
    await press(container.querySelector('[data-testid="phone-files-entry"] button'));
    expect(new Set(seal.map((s) => s.idempotency_key)).size).toBe(2);
  });

  it('«더 보기» asks the next page of the SAME folder with the computer\'s cursor and keeps what was drawn', async () => {
    world.pages = { '|': [entry('a', 'f'), entry('b', 'f')], '|next': [entry('c', 'f')] };
    await screen();
    await press(byId('phone-files-project-proj-1'));
    expect(names()).toEqual(['a', 'b']);
    await press(byId('phone-files-more'));
    expect(seal[1]).toMatchObject({ dir: [], cursor: 'next' });
    expect(names()).toEqual(['a', 'b', 'c']);
    expect(byId('phone-files-more')).toBeNull();
  });

  it('an empty folder says so', async () => {
    world.pages = { '|': [] };
    await screen();
    await press(byId('phone-files-project-proj-1'));
    expect(byId('phone-files-empty')?.textContent).toBe(ko.empty);
  });

  it('several Macs: the person picks one; the projects are those of THAT Mac', async () => {
    world.computers = [computer(), computer({ setup_id: SETUP2, device_name: '사무실 맥', agents: [{ agent_member_id: 'a2', name: 'x', can_command: true, projects: [{ project_id: 'proj-9', name: '다른 일' }] }] })];
    await screen();
    expect(all('phone-files-project-proj-9')).toHaveLength(0);
    await press(byId(`phone-files-computer-${SETUP2}`));
    expect(all('phone-files-project-proj-9')).toHaveLength(1);
    await press(byId('phone-files-project-proj-9'));
    expect(seal[0]).toMatchObject({ setup_id: SETUP2, project_id: 'proj-9' });
  });

  it('[프로젝트 고르기] leaves the folder and asks nothing', async () => {
    await screen();
    await press(byId('phone-files-project-proj-1'));
    const n = posts().length;
    await press(byId('phone-files-back'));
    expect(byId('phone-files-choose')).not.toBeNull();
    expect(posts()).toHaveLength(n);
  });

  it('English words follow the locale', async () => {
    await screen({ locale: 'en' });
    await press(byId('phone-files-project-proj-1'));
    expect(byId('phone-files-hidden')?.textContent).toBe('3 hidden');
    expect(text()).toContain(en.title);
    expect(text()).not.toContain(ko.title);
  });
});

describe('[4983] coming from the session sheet (PO 11-20): the agent\'s own project on that computer', () => {
  const AGENT = 'a1';
  const entry = { setupId: SETUP, agentId: AGENT };
  const one = () => computer({ agents: [{ agent_member_id: AGENT, name: '개발', can_command: true, projects: [{ project_id: 'proj-1', name: '결제 서비스' }] }, { agent_member_id: 'a2', name: '다른', can_command: true, projects: [{ project_id: 'proj-2', name: '문서' }] }] });
  it('the agent has ONE project there → its top opens at once: no choice, one request, the crumbs say which', async () => {
    world.computers = [one()];
    await screen({ entry });
    await flush(); await settle();
    expect(seal).toEqual([{ setup_id: SETUP, project_id: 'proj-1', dir: [], idempotency_key: expect.any(String) }]);
    expect(byId('phone-files-choose')).toBeNull();
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스');
    expect(posts()).toHaveLength(1);
  });
  it('it opens ONCE: leaving the folder for the choice does not open it again by itself', async () => {
    world.computers = [one()];
    await screen({ entry });
    await flush(); await settle();
    await press(byId('phone-files-back'));
    await flush(); await settle();
    expect(seal).toHaveLength(1);
    expect(byId('phone-files-choose')).not.toBeNull();
    expect(all('phone-files-project-proj-2')).toHaveLength(0); // the other agent\'s project is not offered: only this agent\'s
    expect(all('phone-files-project-proj-1')).toHaveLength(1);
  });
  it('several projects of that agent → the choice among THOSE only, no Mac picker, and nothing is asked until one is pressed', async () => {
    world.computers = [computer({ agents: [{ agent_member_id: AGENT, name: '개발', can_command: true, projects: [{ project_id: 'proj-1', name: '결제 서비스' }, { project_id: 'proj-3', name: '정산' }] }, { agent_member_id: 'a2', name: 'x', can_command: true, projects: [{ project_id: 'proj-2', name: '문서' }] }] }), computer({ setup_id: SETUP2, device_name: '사무실 맥' })];
    await screen({ entry });
    await flush(); await settle();
    expect(seal).toHaveLength(0);
    expect(all('phone-files-project-proj-1')).toHaveLength(1);
    expect(all('phone-files-project-proj-3')).toHaveLength(1);
    expect(all('phone-files-project-proj-2')).toHaveLength(0);
    expect(container.querySelector(`[data-testid^="phone-files-computer-"]`)).toBeNull();
    await press(byId('phone-files-project-proj-3'));
    expect(seal[0]).toMatchObject({ setup_id: SETUP, project_id: 'proj-3' });
  });
  it('remote control is off → no request and no prompt by itself: the screen says so', async () => {
    world.remote = false;
    world.computers = [one()];
    await screen({ entry });
    await flush(); await settle();
    expect(seal).toHaveLength(0);
    expect(byId('phone-files-remote-off')?.textContent).toBe(ko.remoteOff);
  });
  it('the computer is not heard from → no request by itself; the line says so', async () => {
    world.computers = [computer({ reachable: false, agents: [{ agent_member_id: AGENT, name: '개발', can_command: true, projects: [{ project_id: 'proj-1', name: '결제 서비스' }] }] })];
    await screen({ entry });
    await flush(); await settle();
    expect(seal).toHaveLength(0);
    expect(byId('phone-files-unreachable')?.textContent).toBe(ko.outcome.unreachable);
    expect((byId('phone-files-project-proj-1') as HTMLButtonElement).disabled).toBe(true);
  });
  it('the agent is not on that computer\'s list (or has no project there) → the ordinary choice, nothing asked', async () => {
    world.computers = [computer()];
    await screen({ entry: { setupId: SETUP, agentId: 'nobody' } });
    await flush(); await settle();
    expect(seal).toHaveLength(0);
    expect(all('phone-files-project-proj-1')).toHaveLength(1);
    expect(all('phone-files-project-proj-2')).toHaveLength(1);
  });
  it('a computer of several setups: the agent is found under ITS OWN setup — and that setup is the one named to the shell', async () => {
    // the server lists one entry per SETUP; entries of one `computer_id` are one computer, each agent keeping the setup it belongs to
    world.computers = [computer({ computer_id: 'c1', agents: [] }), computer({ setup_id: SETUP2, computer_id: 'c1', agents: [{ agent_member_id: AGENT, name: '개발', can_command: true, projects: [{ project_id: 'proj-1', name: '결제 서비스' }] }] })];
    await screen({ entry: { setupId: SETUP2, agentId: AGENT } });
    await flush(); await settle();
    expect(seal[0]).toMatchObject({ setup_id: SETUP2, project_id: 'proj-1' });
  });
  it('outside the phone app the entry asks nothing either', async () => {
    world.computers = [one()];
    await screen({ phone: false, entry });
    await flush(); await settle();
    expect(seal).toHaveLength(0);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
  it('entryOf: the agent\'s projects on the setup it stands on; null for a stranger or an empty list', () => {
    const c = one();
    expect(entryOf([c as never], entry)?.projects.map((p) => p.project_id)).toEqual(['proj-1']);
    expect(entryOf([c as never], { setupId: SETUP2, agentId: AGENT })).toBeNull();
    expect(entryOf([c as never], { setupId: SETUP, agentId: 'zz' })).toBeNull();
    expect(entryOf([computer({ agents: [{ agent_member_id: AGENT, name: 'x', can_command: true, projects: [] }] }) as never], entry)).toBeNull();
  });
});

describe('[4983] every end that is not a list says its own words', () => {
  const open = async () => { await screen(); await press(byId('phone-files-project-proj-1')); };
  it('each closed word of the computer\'s refusal has its line (Korean and English): none is a raw key', async () => {
    for (const reason of FILE_REASONS) {
      world.reason = reason;
      await open();
      expect(byId('phone-files-end')?.textContent, reason).toContain(ko.reason[reason]);
      expect(text()).not.toContain('phoneFiles.');
      await act(async () => { root.unmount(); }); root = createRoot(container);
      server();
    }
  });
  it('the OS prompt cancelled: its own line and a retry that asks again (a new press key)', async () => {
    sealAnswer = () => ({ id: 's', ok: false, code: 'cancelled' });
    await open();
    expect(byId('phone-files-end')?.textContent).toContain(ko.outcome.cancelled);
    expect(posts()).toHaveLength(0);
    sealAnswer = (args) => ({ id: 's', ok: true, envelope: { v: 1 }, phone_key_id: KEYID, idempotency_key: args.idempotency_key });
    await press(container.querySelector('[data-testid="phone-files-end"] button'));
    expect(seal).toHaveLength(2);
    expect(seal[0]!.idempotency_key).not.toBe(seal[1]!.idempotency_key);
    expect(names().length).toBeGreaterThan(0);
  });
  it('the phone cannot confirm: the key words', async () => {
    for (const code of ['biometric_required', 'no_screen_lock', 'key_invalidated', 'no_key', 'not_registered']) {
      sealAnswer = () => ({ id: 's', ok: false, code });
      await open();
      expect(byId('phone-files-end')?.textContent, code).toContain((ko.key as Record<string, string>)[code]);
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });
  it('a post the server refused: busy has a retry; remote off · not allowed have none', async () => {
    world.post = json({ error: { code: 'files_busy' } }, 409);
    await open();
    expect(byId('phone-files-end')?.textContent).toContain(ko.outcome.busy);
    expect(container.querySelector('[data-testid="phone-files-end"] button')).not.toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    world.post = json({ error: { code: 'not_allowed_to_read_files' } }, 403);
    await open();
    expect(byId('phone-files-end')?.textContent).toContain(ko.outcome.not_allowed);
    expect(container.querySelector('[data-testid="phone-files-end"] button')).toBeNull();
  });
  it('an answer that never comes is `timeout` (never «refused»)', async () => {
    world.poll = json({ state: 'delivered', code: null, envelope: null });
    await screen();
    await act(async () => { (byId('phone-files-project-proj-1') as HTMLElement).click(); });
    await flush();
    for (let i = 0; i < 70; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await flush();
    expect(byId('phone-files-end')?.textContent).toContain(ko.outcome.timeout);
  });
  it('leaving the screen while a request is out draws nothing and ends the polling', async () => {
    world.poll = json({ state: 'delivered', code: null, envelope: null });
    await screen();
    await act(async () => { (byId('phone-files-project-proj-1') as HTMLElement).click(); });
    await flush();
    await act(async () => { root.unmount(); });
    const n = calls.length;
    for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(calls.length).toBe(n);
    root = createRoot(container);
  });
});

describe('[4983] small helpers', () => {
  it('sizeText', () => {
    expect(sizeText(0)).toBe('0 B'); expect(sizeText(1023)).toBe('1023 B'); expect(sizeText(1024)).toBe('1 KB'); expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(10 * 1024)).toBe('10 KB'); expect(sizeText(5 * 1024 * 1024)).toBe('5 MB'); expect(sizeText(3 * 1024 ** 3)).toBe('3 GB');
  });
  it('projectsOf lists a project once however many agents work in it', () => {
    const c = computer({ agents: [{ agent_member_id: 'a', name: 'a', can_command: true, projects: [{ project_id: 'p1', name: 'P1' }] }, { agent_member_id: 'b', name: 'b', can_command: false, projects: [{ project_id: 'p1', name: 'P1' }, { project_id: 'p2', name: 'P2' }] }] });
    expect(projectsOf(c as never).map((p) => p.project_id)).toEqual(['p1', 'p2']);
  });
});


// ── [P6] opening one file ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('[4983 P6] a file is opened from the folder that holds it', () => {
  const textBody = (text: string, masked = 0) => ({ v: 1, kind: 'read', ok: true, form: 'text', s: text.length, masked, text });
  async function openFolder(caps: Record<string, unknown> = OPENS) {
    world.caps = caps;
    await screen();
    await press(byId('phone-files-project-proj-1'));
  }

  it('a shell that opens files makes the file rows buttons; one that only lists keeps them plain', async () => {
    await openFolder();
    expect(all('phone-files-file').map((e) => e.textContent)).toEqual(['README.md1.5 KB']);
    expect(all('phone-files-file')[0]!.getAttribute('aria-label')).toBe('README.md 열기');
    expect(names()).toContain('ln바로가기'); // a link and anything else are not asked for
  });
  it('a shell that only lists: no file is offered', async () => {
    await openFolder({ sealed_prompt: 1, files: 1 });
    expect(all('phone-files-file')).toHaveLength(0);
    expect(names()).toContain('README.md1.5 KB');
  });

  it('pressing a file asks the shell for exactly the computer · project · the folder\'s names · the file\'s name · a press key — and the server gets no name', async () => {
    world.read = textBody('hello\nworld');
    await openFolder();
    await press(all('phone-files-entry')[0]!.querySelector('button')); // into `src`
    await press(all('phone-files-file')[0]!); // src/index.ts
    expect(seal.at(-1)).toEqual({ setup_id: SETUP, project_id: 'proj-1', dir: ['src'], name: 'index.ts', idempotency_key: expect.any(String) });
    expect(seal.at(-1)).not.toHaveProperty('cursor');
    const ask = posts().at(-1)!.body!;
    expect(Object.keys(ask).sort()).toEqual(['envelope', 'idempotency_key', 'phone_key_id', 'project_id']);
    expect(JSON.stringify(ask)).not.toContain('index.ts');
    expect(byId('phone-files-crumbs')?.textContent).toBe('결제 서비스 › src › index.ts');
  });

  it('a text is drawn as it came, with the note of the lines that were hidden — and going back shows the list again WITHOUT asking', async () => {
    world.read = textBody('line one\nAPI=••••', 1);
    await openFolder();
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-text')?.textContent).toBe('line one\nAPI=••••');
    expect(byId('phone-files-file-masked')?.textContent).toBe(ko.file.masked.replace('{count}', '1'));
    const before = { seals: seal.length, posts: posts().length };
    await press(byId('phone-files-file-back'));
    expect(byId('phone-files-list')).not.toBeNull();
    expect(names()).toContain('README.md1.5 KB');
    expect({ seals: seal.length, posts: posts().length }).toEqual(before);
  });

  it('an empty file says so; no note when nothing was hidden', async () => {
    world.read = textBody('', 0);
    await openFolder();
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-empty')?.textContent).toBe(ko.file.empty);
    expect(byId('phone-files-file-masked')).toBeNull();
    expect(byId('phone-files-file-text')).toBeNull();
  });

  it('a picture is shown as a data: image of the type and size it said, with a name for a reader', async () => {
    const png = Buffer.from(PNG_HEX, 'hex');
    world.read = { v: 1, kind: 'read', ok: true, form: 'image', s: png.length, mime: 'image/png', w: 1, h: 1, data: png.toString('base64') };
    await openFolder();
    await press(all('phone-files-file')[0]!);
    const img = byId('phone-files-file-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(img.getAttribute('alt')).toBe('README.md 이미지');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['1', '1']);
  });

  it('the type the computer said is the type drawn (a JPEG is not a PNG)', async () => {
    world.read = { v: 1, kind: 'read', ok: true, form: 'image', s: 16, mime: 'image/jpeg', w: 4, h: 3, data: '/9j/4AAAAAAAAAAAAAAAAA==' };
    await openFolder();
    await press(all('phone-files-file')[0]!);
    expect((byId('phone-files-file-image') as HTMLImageElement).getAttribute('src')).toBe('data:image/jpeg;base64,/9j/4AAAAAAAAAAAAAAAAA==');
  });

  it('every closed word has its own sentence for a FILE (a list keeps its own): too big · hidden · not text · looks secret …', async () => {
    await openFolder();
    for (const word of FILE_REASONS) {
      world.read = { v: 1, kind: 'read', ok: false, reason: word };
      await press(all('phone-files-file')[0]!);
      expect(byId('phone-files-file-end')?.textContent).toContain((ko.fileReason as Record<string, string>)[word]);
      await press(byId('phone-files-file-back'));
    }
    expect(ko.fileReason.too_big).not.toBe(ko.reason.too_big);
  });
  it('a refusal that may pass (busy · timeout · changed while reading) offers «try again» and asks again; a refusal that will not (hidden · too big) does not', async () => {
    await openFolder();
    world.read = { v: 1, kind: 'read', ok: false, reason: 'hidden_name' };
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-end')?.querySelector('button')).toBeNull();
    await press(byId('phone-files-file-back'));
    world.read = { v: 1, kind: 'read', ok: false, reason: 'changed_while_reading' };
    await press(all('phone-files-file')[0]!);
    const asked = seal.length;
    world.read = textBody('now fine');
    await press(byId('phone-files-file-end')!.querySelector('button'));
    expect(seal.length).toBe(asked + 1);
    expect(byId('phone-files-file-text')?.textContent).toBe('now fine');
  });
  it('a press the person did not confirm says so and may be tried again', async () => {
    await openFolder();
    sealAnswer = () => ({ id: 's', ok: false, code: 'cancelled' });
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-end')?.textContent).toContain(ko.outcome.cancelled);
    expect(byId('phone-files-file-end')?.querySelector('button')).not.toBeNull();
    expect(posts().filter((c) => c.url.endsWith('/files'))).toHaveLength(1); // only the folder's own list was posted
  });
  it('a body that is not an open answer (a list answering) is drawn as a failure, never as a list', async () => {
    world.read = { v: 1, kind: 'list', ok: true, entries: [{ n: 'x', k: 'f' }], hidden: 0, more: false };
    await openFolder();
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-end')?.textContent).toContain(ko.outcome.failed);
    expect(byId('phone-files-list')).toBeNull();
  });
  it('English words, and a text that holds markup is text (nothing is interpreted)', async () => {
    world.read = textBody('<img src=x onerror=alert(1)>\n<b>bold</b>');
    world.caps = OPENS;
    await screen({ locale: 'en' });
    await press(byId('phone-files-project-proj-1'));
    expect(all('phone-files-file')[0]!.getAttribute('aria-label')).toBe('Open README.md');
    await press(all('phone-files-file')[0]!);
    expect(byId('phone-files-file-text')?.textContent).toBe('<img src=x onerror=alert(1)>\n<b>bold</b>');
    expect(byId('phone-files-file-text')?.querySelector('img, b')).toBeNull();
    expect(byId('phone-files-file-back')?.textContent).toBe(en.file.back);
  });
  it('leaving while a file is being asked draws nothing afterwards', async () => {
    await openFolder();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = phoneCall.getMockImplementation()! as (type: string, args?: Record<string, unknown>) => Promise<unknown>;
    phoneCall.mockImplementation(async (type: string, args?: Record<string, unknown>) => { if (type === 'files.seal') await gate; return orig(type, args); });
    await act(async () => { all('phone-files-file')[0]!.click(); });
    await flush();
    expect(byId('phone-files-file-loading')).not.toBeNull();
    await press(byId('phone-files-file-back'));
    release(); await flush(); await settle();
    expect(byId('phone-files-file-text')).toBeNull();
    expect(byId('phone-files-list')).not.toBeNull();
  });
});
