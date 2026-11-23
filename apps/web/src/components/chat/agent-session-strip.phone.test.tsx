// @vitest-environment jsdom
//
// story #4534 (명세 모음 B-3 · contract 48616ee0 v0.3) — inside the phone app, while the agent works: [멈춤] [지금 지시]. The shell
// signs (its own sheet · the OS prompt), the web posts the shell's values and follows the command; the strip keeps one line for how
// it went (Yuna 12:47Z: the button's own verb · focus · break-keep). Outside the phone app nothing changes (agent-session-strip.test).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';
import { __resetDirectKeepForTest } from '@/lib/phone-direct-keep';

const AGENT = '22222222-3333-4444-8555-666666666666';
const CONV = '33333333-4444-4555-8666-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';

const fetchWithAuth = vi.fn();
// story 4978 (C1b-phone): the provider's record key handoff watch is a stand-in here (it would ask the shell and the server on its own — its file tests it)
vi.mock('@/lib/phone-handoff-watch', () => ({ startHandoffWatch: () => undefined, stopHandoffWatch: () => undefined, ON_OPEN_MS: 60_000, AFTER_PAIRING_MS: 600_000 }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => {} }));
let phone = true;
const phoneCall = vi.fn();
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => phone,
  phoneCall: (...a: unknown[]) => phoneCall(...a),
  claimPhoneBridge: () => {},
  subscribePhoneApp: () => () => {},
}));
let remoteOffNow: { owner: boolean; names: { owners: string; hasOwners: 'yes' | 'no' }; connectedSetups: number } | null = null; // story 4994: the org's «remote control off» (null = on · not known)
vi.mock('@/components/desktop/remote-off', async (orig) => ({ ...(await orig<typeof import('@/components/desktop/remote-off')>()), useRemoteOff: () => remoteOffNow }));
const { AgentSessionStrip } = await import('./agent-session-strip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
let sessionView: Record<string, unknown>;
/** the BFF: the session read · the command post · its polls (in order, the last repeats) · a message post */
function server(post: Response, polls: Response[] = [], message = res(201, { data: { id: 'm-1' } })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/desktop-session')) return res(200, sessionView);
    if (url.endsWith('/desktop-commands') && init?.method === 'POST') return post.clone();
    if (url.includes('/desktop-commands/')) return polls[Math.min(i++, polls.length - 1)]!.clone();
    if (url.endsWith('/messages') && init?.method === 'POST') return message.clone();
    throw new Error(`unexpected ${url}`);
  });
  return calls;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage?.clear(); // drafts (useFieldDraft) do not leak between cases
  phone = true;
  remoteOffNow = null;
  phoneCall.mockReset();
  fetchWithAuth.mockReset();
  sessionView = { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, can_command: true, pending_permission_request_id: null, instruct_now: true };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); __resetDirectKeepForTest(); /* (the direct road's keeper is one per computer for the page's life: a test's screen must not leave it — or its timers — for the next; reset while the fake timers are still the ones it used) */ vi.useRealTimers(); container.remove(); document.body.innerHTML = ''; });

async function settle(n = 6) { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); }
async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <PhoneBridgeClaim><NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentSessionStrip agentId={AGENT} conversationId={CONV} />
      </NextIntlClientProvider></PhoneBridgeClaim>,
    );
  });
  await settle();
}
const strip = () => container.querySelector('[data-testid="agent-session-strip"]')!;
const buttons = () => [...container.querySelectorAll('[data-testid="agent-session-buttons"] button')].map((b) => b.textContent);
const press = async (name: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === name) as HTMLButtonElement | undefined;
  if (!b) throw new Error(`no button ${name}`);
  await act(async () => { b.click(); });
  await settle();
};
const commandLine = () => container.querySelector('[data-testid="agent-command-line"]');
const ko = koMessages.chats.agentSession;
const enMessagesAgent = enMessages.chats.agentSession;
/** run the polls: every 1.5 s */
async function poll(times = 1) { for (let i = 0; i < times; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(1_500); }); await settle(); } }

describe('[4534] the strip inside the phone app', () => {
  it('working · remote control on · may command → [멈춤] [지금 지시] in the line\'s place', async () => {
    server(res(201, {}));
    await render();
    expect(buttons()).toEqual([ko.button.stop, ko.button.instruct]);
    expect(container.querySelector('[data-testid="agent-session-line"]')).toBeNull();
  });

  it('no buttons: not working · remote control off (its line) · a person who may not command · a browser (the phone line)', async () => {
    server(res(201, {}));
    for (const [over, isPhone, line] of [
      [{ state: 'idle' }, true, null],
      [{ remote_control: false }, true, '원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요 — 조직 소유자가 켤 수 있어요'], // story #4583
      [{ can_command: false }, true, null],
      [{}, false, ko.line.onPhone],
    ] as const) {
      phone = isPhone;
      sessionView = { ...sessionView, ...over };
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      expect(buttons()).toEqual([]);
      expect(container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? null).toBe(line);
      sessionView = { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, can_command: true, pending_permission_request_id: null, instruct_now: true };
    }
  });

  it('waiting for permission: the phone app\'s card answers — «결재함에서 답할 수 있어요» (the web: «… 결재함에 있어요»)', async () => {
    sessionView = { ...sessionView, state: 'waiting_permission' };
    server(res(201, {}));
    await render();
    expect(container.querySelector('[data-testid="agent-session-line"]')?.textContent).toBe(ko.line.inboxPhone);
    // Kadir 325 · PO 04:34Z: an agent that asks can still be stopped from the phone — [멈춤] shows, [지금 지시] does not (it goes
    // into a running turn only)
    expect(buttons()).toEqual([ko.button.stop]);
  });

  it('story #4590 (Yuna §2): the question only that computer\'s terminal answers — the card\'s line, no inbox link, [멈춤] only · a browser alike', async () => {
    const words = koMessages.agentPermissions.line.terminalOnly;
    for (const isPhone of [true, false]) {
      phone = isPhone;
      sessionView = { ...sessionView, state: 'waiting_permission', pending_permission_request_id: 'p-1', ask_terminal_only: true };
      server(res(201, {}));
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      const line = container.querySelector('[data-testid="agent-session-line"]');
      expect(line?.textContent).toBe(words);
      expect(line?.tagName).toBe('P'); // not the inbox link
      expect(container.querySelector('a')).toBeNull();
      expect(buttons()).toEqual(isPhone ? [ko.button.stop] : []);
    }
  });

  it('story #4599 (Yuna ① · PO 14:25Z): held by a macOS window — the phone line («여기서 [인계 없이 끝내기]», story 4733: renamed) and one button, [인계 없이 끝내기] ([멈춤] would not work there)', async () => {
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system', system: { folder: 'documents' } };
    server(res(201, {}));
    await render();
    expect(container.querySelector('[data-testid="agent-session-line"]')?.textContent).toBe(ko.line.waitingSystemFolderPhone.replace('{folder}', ko.folder.documents));
    expect(buttons()).toEqual([ko.button.endSession]);
  });

  it('story #4599: a browser, or a phone that may not command, gets no button and the line that says where the handles are (the phone · the desktop app)', async () => {
    server(res(201, {}));
    for (const [over, isPhone] of [[{}, false], [{ can_command: false }, true], [{ remote_control: false }, true]] as const) {
      phone = isPhone;
      sessionView = { ...sessionView, ...over, state: 'working', activity: 'waiting_system', system: { folder: null } };
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      expect(buttons()).toEqual([]);
      expect(container.querySelector('[data-testid="agent-session-line"]')?.textContent).toBe(ko.line.waitingSystem);
    }
  });

  it('story #4599: [인계 없이 끝내기] (story 4733: was [세션 끝내기]) → the confirm dialog (title · body · [취소] focused first) → [취소] signs nothing', async () => {
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system' };
    server(res(201, {}));
    await render();
    await press(ko.button.endSession);
    expect(document.body.textContent).toContain(ko.endDialog.title);
    expect(document.body.textContent).toContain(ko.endDialog.body);
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === ko.endDialog.cancel)!;
    expect(document.activeElement).toBe(cancel);
    await press(ko.endDialog.cancel);
    expect(document.body.textContent).not.toContain(ko.endDialog.title);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign')).toEqual([]); // nothing was signed (the dialog's one look at the key's id is a read)
    expect(buttons()).toEqual([ko.button.endSession]);
  });

  it('story #4599: confirmed → the shell signs `end_session` → posted with the kind the shell returned → done → no line of its own, the state is read again', async () => {
    vi.useFakeTimers();
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system', system: { folder: 'desktop' } };
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S-END', phone_key_id: 'k-1', session_key: 's-9', kind: 'end_session' });
    await render();
    await press(ko.button.endSession);
    const confirm = document.querySelector('[data-testid="agent-end-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await settle();
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'end_session' });
    expect(commandLine()?.textContent).toBe(ko.command.stopping); // the stop's «on its way» line — no words of its own (Yuna ①)
    const reads = () => calls.filter((c) => c.url.endsWith('/desktop-session')).length;
    const before = reads();
    sessionView = { ...sessionView, state: 'stopped', activity: 'stopped', system: null };
    await poll(1);
    expect(commandLine()).toBeNull();
    expect(reads()).toBeGreaterThan(before);
    expect(container.querySelector('[data-testid="agent-session-chip"]')?.textContent).toBe(ko.state.stopped);
    expect(buttons()).toEqual([]);
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toMatchObject({ kind: 'end_session', session_key: 's-9', signed: 'S-END', phone_key_id: 'k-1' });
    expect(JSON.parse(post.init!.body as string)).not.toHaveProperty('text');
  });

  it('story #4599 (Yuna · PO 19:47Z): [세션 끝내기] confirmed after the window was answered on that Mac → the shell says not_held → «세션은 끝내지 않았어요» — never «다시 눌러 주세요» (that would press [멈춤] on a working turn) · nothing posted', async () => {
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system', system: { folder: 'documents' } };
    const calls = server(res(201, { command_id: CMD, state: 'queued' }));
    phoneCall.mockResolvedValue({ id: 'w', ok: false, code: 'not_held' });
    await render();
    await press(ko.button.endSession);
    const confirm = document.querySelector('[data-testid="agent-end-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.endNotHeld);
    expect(commandLine()?.textContent).not.toBe(ko.command.stop.failed);
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    // en
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render('en');
    await press(enMessages.chats.agentSession.button.endSession);
    await act(async () => { (document.querySelector('[data-testid="agent-end-confirm"]') as HTMLButtonElement).click(); });
    await settle();
    expect(commandLine()?.textContent).toBe(enMessages.chats.agentSession.command.endNotHeld);
  });

  it('story #4599 (PO 14:18Z): [멈춤] pressed just before the window came up — the server\'s closed reason → its own line, nothing as a message', async () => {
    const calls = server(res(409, { error: { code: 'system_wait_end_only' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' });
    await render();
    await press(ko.button.stop);
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.stopSystemWait);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  it('waiting for permission, [멈춤] signs a stop the same way (agent only) and posts it', async () => {
    vi.useFakeTimers();
    sessionView = { ...sessionView, state: 'waiting_permission' };
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' });
    await render();
    await press(ko.button.stop);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'stop_session' });
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.stopped);
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toMatchObject({ kind: 'stop_session', session_key: 's-9', signed: 'S' });
  });

  // story 4943 (PO 11-14 ③ A): the daemon stopped the turn but a background command still runs → the line says exactly that (never the plain «멈췄어요»)
  it('[멈춤] done with commands_running → «턴은 멈췄지만 백그라운드에서 도는 명령은 계속 돌고 있어요», not the plain stopped line', async () => {
    vi.useFakeTimers();
    server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'acked' }), res(200, { state: 'done', result_code: 'commands_running' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' });
    await render();
    await press(ko.button.stop);
    await poll(2);
    expect(commandLine()?.textContent).toBe(ko.command.stoppedCommandsRunning);
    expect(ko.command.stoppedCommandsRunning).not.toBe(ko.command.stopped);
  });

  it('[멈춤]: the shell signs a stop (agent only) → posted → followed to «멈췄어요 …», the line takes focus', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'acked' }), res(200, { state: 'done' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' });
    await render();
    await press(ko.button.stop);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'stop_session' });
    expect(commandLine()?.textContent).toBe(ko.command.stopping);
    await poll(2);
    expect(commandLine()?.textContent).toBe(ko.command.stopped);
    expect(document.activeElement).toBe(commandLine());
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toMatchObject({ kind: 'stop_session', session_key: 's-9', signed: 'S', phone_key_id: 'k-1' });
  });

  // story 4976 A3: a shell that can seal — the instruction goes as an envelope; the words are in no byte of the post; a turn that has ended is NOT turned into a message, and what was written stays
  it('[4976] a sealing shell: the post is the envelope (no words) · «… 단계를 마치면 바로 들어가요» · and a session that cannot take it → «보내지 않았어요» line, no message post, the words stay', async () => {
    vi.useFakeTimers();
    const ENV = { v: 1, kind: 'send_prompt', command_id: 'k', ct: 'AAAA' };
    let signs = 0;
    phoneCall.mockImplementation(async (type: string, args: Record<string, unknown>) => {
      if (type === 'shell.caps') return { id: 'c', ok: true, caps: { sealed_prompt: 1 } };
      signs += 1;
      expect(args).toMatchObject({ kind: 'send_prompt', text: 'secret words 4976', conversation_id: CONV, sealed: true });
      expect(typeof args.idempotency_key).toBe('string');
      return signs === 1 ? { id: 'w', ok: true, sealed: true, envelope: ENV, phone_key_id: 'k-1', session_key: 's-9', conversation_id: CONV } : { id: 'w', ok: false, code: 'not_working' };
    });
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done', result_code: 'after_step' })]);
    sessionView = { ...sessionView, sealed_prompt: true }; // this computer's app says it opens a sealed instruction
    await render();
    const type = async (text: string) => {
      await press(ko.button.instruct);
      const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text); box.dispatchEvent(new Event('input', { bubbles: true })); });
      await press(ko.sheet.send);
    };
    await type('secret words 4976');
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.sentAfterStep);
    const posted = calls.filter((c) => c.init?.method === 'POST');
    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0]!.init!.body as string);
    expect(body).toMatchObject({ kind: 'send_prompt', conversation_id: CONV, session_key: 's-9', phone_key_id: 'k-1', envelope: ENV });
    expect(body).not.toHaveProperty('text');
    expect(body).not.toHaveProperty('signed');
    expect(String(posted[0]!.init!.body)).not.toContain('secret words');
    // the session cannot take the next one: said, not sent, no message; the words stay in the box
    await type('secret words 4976');
    expect(commandLine()?.textContent).toBe(ko.command.sealedNotTaken);
    expect(calls.filter((c) => String(c.url).includes('/messages'))).toEqual([]);
    await press(ko.button.instruct);
    expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value).toBe('secret words 4976');
  });

  it('[4990] a phone with a sealing pin and NO pin for this computer (the server names it anyway): the sealed call says host_not_pinned, the page\'s plain re-send is refused by the shell → the reason line + the pair-again way; NOTHING is posted, no chat message, the words stay', async () => {
    vi.useFakeTimers();
    const signs: Array<Record<string, unknown>> = [];
    phoneCall.mockImplementation(async (type: string, args: Record<string, unknown>) => {
      if (type === 'shell.caps') return { id: 'c', ok: true, caps: { sealed_prompt: 1 } };
      signs.push(args);
      return args.sealed === true ? { id: 'w', ok: false, code: 'host_not_pinned' } : { id: 'w', ok: false, code: 'sealed_pair_missing' };
    });
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done', result_code: null })]);
    sessionView = { ...sessionView, sealed_prompt: true }; // the server says this computer opens a sealed instruction — the phone's own table has no pin for it
    await render();
    await press(ko.button.instruct);
    const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'secret words 4990'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await press(ko.sheet.send);
    expect(signs.map((a) => a.sealed)).toEqual([true, undefined]); // the sealed road first, then the plain re-send the shell refuses
    expect(commandLine()?.textContent).toBe(ko.command.sealedPairMissing);
    expect(Array.from(document.querySelectorAll('a')).some((a) => a.textContent === ko.command.pairAgain), 'the way to pair again is there').toBe(true);
    expect(calls.filter((c) => c.init?.method === 'POST'), 'nothing posted').toEqual([]);
    expect(calls.filter((c) => String(c.url).includes('/messages')), 'no chat message').toEqual([]);
    expect(JSON.stringify(calls.map((c) => c.init?.body ?? ''))).not.toContain('secret words');
    await press(ko.button.instruct);
    expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value, 'what the person wrote stays').toBe('secret words 4990');
  });

  it('[4976] a shell that can seal but a computer that has NOT said its app opens one → the plain road (the session view\'s `sealed_prompt` is what lets a sealed instruction be made)', async () => {
    vi.useFakeTimers();
    phoneCall.mockImplementation(async (type: string) => (type === 'shell.caps' ? { id: 'c', ok: true, caps: { sealed_prompt: 1 } } : { id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'go on' }));
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]);
    for (const flag of [undefined, false, null]) {
      sessionView = { ...sessionView, sealed_prompt: flag as never };
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      await press(ko.button.instruct);
      const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'go on'); box.dispatchEvent(new Event('input', { bubbles: true })); });
      await press(ko.sheet.send);
    }
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'shell.caps')).toEqual([]);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign').every((c) => !('sealed' in (c[1] as object)))).toBe(true);
    const posted = calls.filter((c) => c.init?.method === 'POST');
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((c) => JSON.parse(c.init!.body as string).signed === 'S')).toBe(true);
  });

  it('[지금 지시]: the sheet (title · note) → [보내기] → the shell gets the text and this conversation → «… 단계를 마치면 바로 들어가요» · the draft goes', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done', result_code: 'after_step' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    expect(document.body.textContent).toContain(ko.sheet.title);
    expect(document.body.textContent).toContain(ko.sheet.note);
    const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(8000);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'run the tests');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(ko.sheet.send);
    expect(phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'send_prompt', text: 'run the tests', conversation_id: CONV });
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.sentAfterStep);
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init!.body as string)).toMatchObject({ kind: 'send_prompt', text: 'run the tests', conversation_id: CONV, session_key: 's-9' });
    await press(ko.button.instruct);
    expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value).toBe('');
  });

  it('the turn had ended (409): the instruction goes in as a message into this conversation — never lost', async () => {
    const calls = server(res(409, { error: { code: 'session_not_working' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'run the tests'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await press(ko.sheet.send);
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.sentAsMessage);
    const msg = calls.find((c) => c.url === `/api/conversations/${CONV}/messages`)!;
    expect(JSON.parse(msg.init!.body as string)).toEqual({ content: 'run the tests' });
  });

  const typeAndSend = async (text: string) => {
    await press(ko.button.instruct);
    const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await press(ko.sheet.send);
  };
  const posts = () => fetchWithAuth.mock.calls.filter(([u, i]) => String(u).endsWith('/desktop-commands') && (i as RequestInit | undefined)?.method === 'POST');

  it('Kadir 4955: an instruction whose end is not known (two minutes of wall clock) → «… 이미 들어갔을 수 있어요» · [지금 지시] becomes [결과 확인] · [멈춤] stays · nothing as a message', async () => {
    vi.useFakeTimers();
    const polls = [res(200, { state: 'delivered' })];
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), polls);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'keep me' });
    await render();
    await typeAndSend('keep me');
    await poll(81);
    expect(commandLine()?.textContent).toBe(ko.command.sendUnknown);
    expect(buttons()).toEqual([ko.button.stop, ko.button.checkResult]);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
    // [결과 확인] → the SAME command followed (no signature · no post) → its real end
    polls.splice(0, 1, res(200, { state: 'done', result_code: 'after_step' }));
    await press(ko.button.checkResult);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.sentAfterStep);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'command.sign')).toHaveLength(1); // (an instruction first asks the shell what it can do — `shell.caps` — that is a read, not a signature)
    expect(posts().length).toBe(1);
    expect(buttons()).toEqual([ko.button.stop, ko.button.instruct]);
  });

  it('Kadir 4955: a stop whose post answer was lost → «… 이미 멈췄을 수 있어요» · both buttons become [결과 확인] · it posts the same key again → the server\'s command → «멈췄어요»', async () => {
    vi.useFakeTimers();
    let lose = true;
    server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]);
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (lose && url.endsWith('/desktop-commands') && init?.method === 'POST') { lose = false; throw new TypeError('network'); }
      return base(url, init);
    });
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' });
    await render();
    await press(ko.button.stop);
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.stopUnknown);
    expect(buttons()).toEqual([ko.button.checkResult]);
    await press(ko.button.checkResult);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.stopped);
    expect(phoneCall).toHaveBeenCalledTimes(1);
    const keys = posts().map(([, i]) => JSON.parse((i as RequestInit).body as string).idempotency_key);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a refusal before anything was made (409 device_unreachable) stays «… 보내지 못했어요» — known, and the buttons stay', async () => {
    server(res(409, { error: { code: 'device_unreachable' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'x' });
    await render();
    await typeAndSend('x');
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.sendUnreachable);
    expect(buttons()).toEqual([ko.button.stop, ko.button.instruct]);
    await press(ko.button.instruct);
    expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value).toBe('x');
  });

  it('refusals keep the button\'s verb and their way out: signed out → [다시 로그인] · key lost → [다시 페어링] · no screen lock → [설정 열기]', async () => {
    server(res(201, {}));
    for (const [code, stopLine, sendLine, action] of [
      ['signed_out', ko.command.stop.signedOut, ko.command.send.signedOut, ko.command.signInAgain],
      ['key_invalidated', ko.command.stop.keyInvalidated, ko.command.send.keyInvalidated, ko.command.pairAgain],
      ['no_screen_lock', ko.command.stop.noScreenLock, ko.command.send.noScreenLock, ko.command.openSettings],
      ['cancelled', ko.command.stop.cancelled, ko.command.send.cancelled, null],
      ['conversation_not_found', ko.command.conversationNotFound, ko.command.conversationNotFound, null],
      ['sign_failed', ko.command.stop.failed, ko.command.send.failed, null],
    ] as const) {
      phoneCall.mockResolvedValue({ id: 'w', ok: false, code });
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      await press(ko.button.stop);
      if (code !== 'conversation_not_found') expect(commandLine()?.textContent).toBe(stopLine);
      expect(commandLine()?.parentElement?.querySelector('a,button')?.textContent ?? null).toBe(code === 'conversation_not_found' ? null : action);
      await press(ko.button.instruct);
      const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'x'); box.dispatchEvent(new Event('input', { bubbles: true })); });
      await press(ko.sheet.send);
      expect(commandLine()?.textContent).toBe(sendLine);
      expect(commandLine()?.className).toContain('break-keep');
      await press(ko.button.instruct);
      expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value, `${code}: what was written stays`).toBe('x');
    }
    expect(fetchWithAuth.mock.calls.some(([u, i]) => String(u).endsWith('/desktop-commands') && (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('story 4994: in the guest desktop app (a COMPUTER) not registered · no screen lock · no sealed pairing say «이 컴퓨터» (stop and send, ko and en) and the no-screen-lock line has no settings button', async () => {
    const ua = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36');
    try {
      for (const locale of ['ko', 'en'] as const) {
        const m = (locale === 'ko' ? ko : enMessages.chats.agentSession) as typeof ko;
        for (const [code, stopLine, sendLine, action] of [
          ['not_registered', m.command.stop.notRegisteredComputer, m.command.send.notRegisteredComputer, m.command.pairAgain],
          ['no_screen_lock', m.command.stop.noScreenLockComputer, m.command.send.noScreenLockComputer, null],
        ] as const) {
          server(res(201, {}));
          phoneCall.mockResolvedValue({ id: 'w', ok: false, code });
          await act(async () => { root.unmount(); }); root = createRoot(container);
          await render(locale);
          await press(m.button.stop);
          expect(commandLine()?.textContent, `${locale} ${code} stop`).toBe(stopLine);
          expect(commandLine()?.parentElement?.querySelector('a,button')?.textContent ?? null, `${locale} ${code} action`).toBe(action);
          await press(m.button.instruct);
          const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
          await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'x'); box.dispatchEvent(new Event('input', { bubbles: true })); });
          await press(m.sheet.send);
          expect(commandLine()?.textContent, `${locale} ${code} send`).toBe(sendLine);
        }
        // a sealed instruction with no secure pairing: the shell's own refusal word
        server(res(201, {}));
        phoneCall.mockResolvedValue({ id: 'w', ok: false, code: 'sealed_pair_missing' });
        await act(async () => { root.unmount(); }); root = createRoot(container);
        await render(locale);
        await press(m.button.instruct);
        const box2 = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
        await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box2, 'x'); box2.dispatchEvent(new Event('input', { bubbles: true })); });
        await press(m.sheet.send);
        expect(commandLine()?.textContent, `${locale} sealed_pair_missing`).toBe(m.command.sealedPairMissingComputer);
      }
    } finally { ua.mockRestore(); }
    for (const lang of [ko, enMessages.chats.agentSession as typeof ko]) {
      for (const text of [lang.command.stop.notRegisteredComputer, lang.command.send.notRegisteredComputer, lang.command.stop.noScreenLockComputer, lang.command.send.noScreenLockComputer, lang.command.sealedPairMissingComputer]) expect(text).not.toMatch(/폰|phone/i);
    }
  });

  it('story 4994: remote control off in the guest desktop app (a COMPUTER): the status line says «이 컴퓨터», not «폰»; a non-phone window keeps the old words', async () => {
    server(res(201, {}));
    const ua = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36');
    try {
      for (const locale of ['ko', 'en'] as const) {
        const m = (locale === 'ko' ? ko : enMessages.chats.agentSession) as typeof ko;
        phone = true; sessionView = { ...sessionView, remote_control: false };
        await act(async () => { root.unmount(); }); root = createRoot(container);
        await render(locale);
        const text = container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? '';
        expect(text, locale).toContain(locale === 'ko' ? '이 컴퓨터에서 멈추거나 지시할 수 없어요' : 'from this computer');
        expect(text, locale).not.toMatch(/폰|phone/i);
        expect(m.line.remoteOffOwnerComputer, locale).not.toMatch(/폰|phone/i); expect(m.line.remoteOffOthersComputer, locale).not.toMatch(/폰|phone/i);
        sessionView = { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, can_command: true, pending_permission_request_id: null, instruct_now: true };
      }
      // not the phone app (a plain window with an Electron UA but no bridge): the old words stay
      phone = false; sessionView = { ...sessionView, remote_control: false };
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await render('ko');
      expect(container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? '').toContain('폰에서 멈추거나 지시할 수 없어요');
    } finally { ua.mockRestore(); }
  });

  it('story 4994: remote control off for an owner / someone else in the guest desktop app (a COMPUTER): the status line AND a refused command say «이 컴퓨터»; a phone keeps «폰»', async () => {
    const ua = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36');
    try {
      for (const owner of [true, false]) {
        remoteOffNow = { owner, names: { owners: '민', hasOwners: 'yes' }, connectedSetups: 1 };
        // the status line (the session says remote control is off)
        sessionView = { ...sessionView, remote_control: false };
        server(res(201, {}));
        await act(async () => { root.unmount(); }); root = createRoot(container);
        await render();
        const line = container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? '';
        expect(line, `status owner=${owner}`).toContain('이 컴퓨터에서 멈추거나 지시할 수 없어요');
        expect(line).not.toMatch(/폰/);
        // the command line (the server refuses a stop with remote_control_off)
        sessionView = { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, can_command: true, pending_permission_request_id: null, instruct_now: true };
        server(res(409, { error: { code: 'remote_control_off' } }));
        phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'x' });
        await act(async () => { root.unmount(); }); root = createRoot(container);
        await render();
        await press(ko.button.stop); await settle();
        const cmd = commandLine()?.textContent ?? '';
        expect(cmd, `command owner=${owner}`).toContain('이 컴퓨터에서 멈추거나 지시할 수 없어요');
        expect(cmd).not.toMatch(/폰/);
      }
    } finally { ua.mockRestore(); remoteOffNow = null; }
  });

  it('story 4994 (D-3): the server says 409 phone_not_paired — in a phone the line says «이 폰», in the guest desktop app (a COMPUTER) it says «이 컴퓨터» (stop and send, ko and en)', async () => {
    const MAC_APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36';
    for (const guest of [false, true]) {
      const ua = guest ? vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(MAC_APP) : null;
      try {
        for (const locale of ['ko', 'en'] as const) {
          const m = (locale === 'ko' ? ko : enMessages.chats.agentSession) as typeof ko;
          server(res(409, { error: { code: 'phone_not_paired' } }));
          phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'x' });
          await act(async () => { root.unmount(); }); root = createRoot(container);
          await render(locale);
          await press(m.button.stop); await settle();
          expect(commandLine()?.textContent, `${locale} guest=${guest} stop`).toBe(guest ? m.command.stop.notPairedComputer : m.command.stop.notPaired);
          await press(m.button.instruct);
          await act(async () => { const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'x'); box.dispatchEvent(new Event('input', { bubbles: true })); });
          await press(m.sheet.send); await settle();
          expect(commandLine()?.textContent, `${locale} guest=${guest} send`).toBe(guest ? m.command.send.notPairedComputer : m.command.send.notPaired);
        }
      } finally { ua?.mockRestore(); }
    }
    for (const lang of [ko, enMessages.chats.agentSession as typeof ko]) {
      expect(lang.command.stop.notPairedComputer).not.toMatch(/폰|phone/i); expect(lang.command.send.notPairedComputer).not.toMatch(/폰|phone/i);
    }
  });

  it('reads in English', async () => {
    server(res(201, {}));
    await render('en');
    expect(buttons()).toEqual(['Stop', 'Instruct now']);
    expect(enMessages.chats.agentSession.sheet.title).toBe('Add to what the agent is doing now');
  });
});

// story #4534 (PO 06:20Z · 06:30Z · 06:31Z · Yuna 06:29Z · 06:30Z · Kadir 06:21Z ④ · 06:31Z): whether an instruction can go into this
// session's turn — the daemon says (it reads it once at the session's start); the button only when it says so; a longer one stopped
// on the sheet before it is signed; the daemon's «not now» → a message, said as such
describe('[4534] [지금 지시] only when the daemon can put it into the turn', () => {
  const type = async (text: string) => {
    const box = document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text); box.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const line = () => container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? null;

  it('false → [멈춤] only, and the line says why · null (a daemon from before) → [멈춤] only, no line · true → both', async () => {
    server(res(201, {}));
    for (const [instruct_now, want, why] of [
      [false, [ko.button.stop], ko.line.instructNotNow],
      [null, [ko.button.stop], null],
      [undefined, [ko.button.stop], null],
      [true, [ko.button.stop, ko.button.instruct], null],
    ] as const) {
      sessionView = { ...sessionView, instruct_now };
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      expect(buttons()).toEqual(want);
      expect(line()).toBe(why);
    }
  });

  it('waiting on a permission with instruct_now true → [멈춤] only (web PR 4962 stops then too) · [지금 지시] goes into a running turn only (PO 07:00Z)', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, state: 'waiting_permission', instruct_now: true };
    await render();
    expect(buttons()).toEqual([ko.button.stop]);
  });

  it('the sheet counts code points «{n} / 400자» · over 400 → the count in red, its line, [보내기] off — the text is never cut', async () => {
    server(res(201, {}));
    await render();
    await press(ko.button.instruct);
    const count = () => document.querySelector('[data-testid="agent-instruct-count"]');
    const send = () => [...document.querySelectorAll('button')].find((b) => b.textContent === ko.sheet.send) as HTMLButtonElement;
    expect(count()?.textContent).toBe('0 / 400자');
    await type('😀'.repeat(400)); // 800 UTF-16 units — 400 code points: allowed
    expect(count()?.textContent).toBe('400 / 400자');
    expect(count()?.className).toContain('text-muted-foreground');
    expect(document.querySelector('[data-testid="agent-instruct-too-long"]')).toBeNull();
    expect(send().disabled).toBe(false);
    await type('가'.repeat(401));
    expect(count()?.textContent).toBe('401 / 400자');
    expect(count()?.className).toContain('text-destructive');
    expect(document.querySelector('[data-testid="agent-instruct-too-long"]')?.textContent).toBe(ko.sheet.tooLong);
    expect(send().disabled).toBe(true);
    expect((document.querySelector('[data-testid="agent-instruct-text"][data-slot="textarea"]') as HTMLTextAreaElement).value).toHaveLength(401);
    expect(phoneCall).not.toHaveBeenCalled();
  });

  it('the daemon could not put it into the turn (instruct_not_now) → it goes in as a message, with its own line', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'rejected', result_code: 'instruct_not_now' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    await type('run the tests');
    await press(ko.sheet.send);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.sentAsMessageNotNow);
    const msg = calls.find((c) => c.url === `/api/conversations/${CONV}/messages`)!;
    expect(JSON.parse(msg.init!.body as string)).toEqual({ content: 'run the tests' });
  });

  it('the server refuses a longer one (instruct_too_long) → the sheet\'s line, nothing as a message', async () => {
    const calls = server(res(422, { error: { code: 'instruct_too_long' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    await type('run the tests');
    await press(ko.sheet.send);
    expect(commandLine()?.textContent).toBe(ko.sheet.tooLong);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  // story 4633 (contract v0.4 §3 · Yuna's web line): a text the daemon refused for its hidden characters gets its own line, and it never
  // goes into the chat as a message (the same words would arrive unchecked there)
  it('[4633] the daemon refused it for hidden characters (instruct_hidden_text) → its own line, nothing as a message', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'rejected', result_code: 'instruct_hidden_text' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    await type('run the tests');
    await press(ko.sheet.send);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.hiddenText);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  it('[4633] the server refuses it for hidden characters (instruct_hidden_text) → its own line, nothing as a message', async () => {
    const calls = server(res(422, { error: { code: 'instruct_hidden_text' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    await type('run the tests');
    await press(ko.sheet.send);
    expect(commandLine()?.textContent).toBe(ko.command.hiddenText);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  // story 4633 (PO correction): the «send as a message» route is closed by the same check — a text with a hidden character never goes
  // into the chat, even when the daemon only said «not now» (the fallback would deliver it unchecked)
  it('[4633] the daemon said «not now», but the text holds a hidden character → no message; its own line', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'rejected', result_code: 'instruct_not_now' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: `run${String.fromCodePoint(0x200b)} the tests` });
    await render();
    await press(ko.button.instruct);
    await type(`run${String.fromCodePoint(0x200b)} the tests`);
    await press(ko.sheet.send);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.hiddenText);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  // story 4633 (Kadir 943fac90f · survivors): the two other message routes are held by the same check — the daemon found the turn ended
  // (session_not_working) on the poll, and the server found it ended on the post — a hidden character means no message on either
  it('[4633] the daemon found the turn ended (session_not_working) and the text holds a hidden character → no message; its own line', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'rejected', result_code: 'session_not_working' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: `run${String.fromCodePoint(0x200b)} the tests` });
    await render();
    await press(ko.button.instruct);
    await type(`run${String.fromCodePoint(0x200b)} the tests`);
    await press(ko.sheet.send);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.hiddenText);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  it('[4633] the server found the turn ended (409 session_not_working) and the text holds a hidden character → no message; its own line', async () => {
    const calls = server(res(409, { error: { code: 'session_not_working' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: `run${String.fromCodePoint(0x200b)} the tests` });
    await render();
    await press(ko.button.instruct);
    await type(`run${String.fromCodePoint(0x200b)} the tests`);
    await press(ko.sheet.send);
    expect(commandLine()?.textContent).toBe(ko.command.hiddenText);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  it('[4633 · probe] a tab and a CR in the text are not hidden characters — the not-now fallback still sends it as a message', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'rejected', result_code: 'instruct_not_now' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run\tthe\rtests' });
    await render();
    await press(ko.button.instruct);
    await type('run\tthe\rtests');
    await press(ko.sheet.send);
    await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.sentAsMessageNotNow);
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(true);
  });
});


describe('[4733 S4b] the hard end\'s dialog points at the phone\'s own [세션 종료] — only where that button exists (Yuna 4733 §6)', () => {
  const SETUP = '11111111-2222-4333-8444-555555555555';
  const KEY = 'p-1';
  /** the BFF as above, plus the three reads the dialog makes when it opens */
  function serverWithClock(world: { startable?: unknown; clock?: Response; devices?: unknown }) {
    server(res(201, {}));
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/remote-devices') return res(200, { devices: world.devices ?? [{ id: KEY, confirm_number: '482 917' }] });
      if (url.startsWith('/api/desktop/startable')) return res(200, world.startable ?? { remote_control: true, computers: [{ setup_id: SETUP, device_name: 'SYJ-MacBook-Pro', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: true }] }] });
      if (url.includes('/clock?phone_key_id=')) return (world.clock ?? res(200, { remote_control: true, reachable: true, supported: true, view: null })).clone();
      return base(url, init);
    });
  }
  const openDialog = async () => {
    phoneCall.mockImplementation(async (type: string) => (type === 'device.key.info' ? { id: 'k', ok: true, key_number: '482 917' } : { id: 'x', ok: false, code: 'cancelled' }));
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system' };
    await render();
    await press(ko.button.endSession);
    await settle(12);
  };

  it('the dialog\'s new title, body and confirm are the renamed words; the extra paragraph is drawn when the agent\'s computer speaks `clock` and this person may command it', async () => {
    serverWithClock({});
    await openDialog();
    expect(document.body.textContent).toContain('인계 없이 세션을 끝낼까요?');
    expect(document.querySelector('[data-testid="agent-end-confirm"]')?.textContent).toBe('인계 없이 끝내기');
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')?.textContent).toBe('인계는 남기지 않아요 — 인계를 남기려면 [세션 종료]를 쓰세요.');
  });

  it.each([
    ['an old app on that computer (`supported` false)', { clock: res(200, { remote_control: true, reachable: true, supported: false, view: null }) }],
    ['a person who may not command that computer (403)', { clock: res(403, { error: { code: 'not_allowed_to_command' } }) }],
    ['remote control off', { clock: res(200, { remote_control: false, reachable: true, supported: true, view: null }) }],
    ['the agent is on none of this phone\'s computers', { startable: { remote_control: true, computers: [{ setup_id: SETUP, device_name: 'M', reachable: true, agents: [] }] } }],
    ['the agent has no running session on that computer (no [세션 종료] row for it)', { startable: { remote_control: true, computers: [{ setup_id: SETUP, device_name: 'M', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: false }] }] } }],
    ['that computer cannot be reached now', { clock: res(200, { remote_control: true, reachable: false, supported: true, view: null }) }],
    ['this phone is paired with nothing', { startable: { remote_control: true, computers: [] } }],
    ['the phone\'s key is not on the server\'s list', { devices: [{ id: 'x', confirm_number: '000 000' }] }],
  ])('%s → the paragraph is NOT drawn (it would point at nothing)', async (_name, world) => {
    serverWithClock(world as never);
    await openDialog();
    expect(document.body.textContent).toContain('인계 없이 세션을 끝낼까요?');
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')).toBeNull();
  });

  it('the session\'s OWN computer decides: the server names it (`setup_id`) → that computer\'s `clock` answer counts, not another computer\'s where the agent also runs', async () => {
    const OTHER = '99999999-2222-4333-8444-555555555555';
    serverWithClock({
      startable: { remote_control: true, computers: [
        { setup_id: OTHER, device_name: 'Mini', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: true }] },
        { setup_id: SETUP, device_name: 'M', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: true }] },
      ] },
    });
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (url.includes(`/api/desktop/setups/${OTHER}/clock?`) ? res(200, { remote_control: true, reachable: true, supported: false, view: null }) : base(url, init)));
    sessionView = { ...sessionView, setup_id: SETUP };
    await openDialog();
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')).not.toBeNull(); // SETUP speaks clock
    // the same two computers, but the session runs on the one that does NOT speak it
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    sessionView = { ...sessionView, setup_id: OTHER };
    await openDialog();
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')).toBeNull();
  });

  it('two computers run the agent and the server names none → no guess: no paragraph', async () => {
    serverWithClock({
      startable: { remote_control: true, computers: [
        { setup_id: SETUP, device_name: 'M', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: true }] },
        { setup_id: '88888888-2222-4333-8444-555555555555', device_name: 'Mini', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [], running: true }] },
      ] },
    });
    await openDialog();
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')).toBeNull();
  });

  it('English: the same structure with the English words', async () => {
    serverWithClock({});
    sessionView = { ...sessionView, state: 'working', activity: 'waiting_system' };
    phoneCall.mockImplementation(async (type: string) => (type === 'device.key.info' ? { id: 'k', ok: true, key_number: '482 917' } : { id: 'x', ok: false, code: 'cancelled' }));
    await render('en');
    await press(enMessagesAgent.button.endSession);
    await settle(12);
    expect(enMessagesAgent.button.endSession).toBe('End without a handoff');
    expect(document.body.textContent).toContain('End the session without a handoff?');
    expect(document.querySelector('[data-testid="agent-end-use-clock"]')?.textContent).toBe('No handoff is left — to leave one, use [End session].');
  });
});

describe('the «바뀐 파일» button next to the stop / instruct buttons (story 4951 ①c)', () => {
  it('joins THEIR group — one right-aligned group in the strip, not two (two `ml-auto` groups split the free space and the button floats mid-row)', async () => {
    sessionView = { ...sessionView, can_read_changes: true, session_key: 's-1' };
    server(res(201, { command_id: CMD }));
    await render();
    expect(buttons()).toEqual(['바뀐 파일', '멈춤', '지금 지시']);
    expect([...strip().children].filter((c) => c.classList.contains('ml-auto'))).toHaveLength(1);
    // with nothing else to press it stands alone at the right end — still one group
    sessionView = { ...sessionView, state: 'idle', can_read_changes: true, session_key: 's-1' };
    await act(async () => { root.unmount(); }); root = createRoot(container);
    server(res(201, { command_id: CMD }));
    await render();
    expect(container.querySelector('[data-testid="agent-changes-open"]')).not.toBeNull();
    expect([...strip().children].filter((c) => c.classList.contains('ml-auto'))).toHaveLength(1);
  });
});

describe('[4983] the files line of the «바뀐 파일» sheet', () => {
  const SETUP = '11111111-2222-4333-8444-555555555555';
  const filesLine = () => document.body.querySelector<HTMLAnchorElement>('[data-testid="agent-changes-files"]');
  async function openSheet() {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return res(201, { command_id: '33333333-4444-4555-8666-777777777777' });
      if (String(url).includes('desktop-changes')) return res(200, { state: 'done', files: [], more: false, total: 0 });
      return res(200, sessionView);
    });
    await render();
    await act(async () => { (container.querySelector('[data-testid="agent-changes-open"]') as HTMLButtonElement).click(); });
    await settle(12);
  }
  it('inside the phone app the sheet\'s last line goes to THIS computer and THIS agent — nothing else rides on the address', async () => {
    sessionView = { ...sessionView, setup_id: SETUP, session_key: 's-1', can_read_changes: true };
    await openSheet();
    expect(filesLine()?.getAttribute('href')).toBe(`/phone-files?setup_id=${SETUP}&agent_id=${AGENT}`);
  });
  it('in a browser the line is not drawn (only the phone app\'s shell can sign)', async () => {
    phone = false;
    sessionView = { ...sessionView, setup_id: SETUP, session_key: 's-1', can_read_changes: true };
    await openSheet();
    expect(filesLine()).toBeNull();
  });
  it('a session that names no computer (an older server) has no line', async () => {
    sessionView = { ...sessionView, session_key: 's-1', can_read_changes: true };
    await openSheet();
    expect(filesLine()).toBeNull();
    sessionView = { ...sessionView, setup_id: '' };
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await openSheet();
    expect(filesLine()).toBeNull();
  });
});

// (last in the file: its open sheet is a dialog, and a dialog left to the unmount must not be the one the earlier dialog tests start from)
describe('[4977] the «기록» button of the strip', () => {
  const SETUP = '55555555-6666-4777-8888-999999999999';
  const caps = (records: unknown) => phoneCall.mockImplementation(async (type: string) => (type === 'shell.caps' ? { id: 'c', ok: true, caps: records === undefined ? {} : { records } } : { id: 'c', ok: false, code: 'bad_request' }));
  const recordsButton = () => container.querySelector('[data-testid="agent-records-open"]') as HTMLButtonElement | null;

  // story 4993 (PO ⓐ): the strip is a screen of that computer — in the phone app, with a shell that says `direct: 1` + `direct_keep: 1`, its room keeps the computer's direct road (`direct.keep` with THAT computer's id); outside the phone app, or with a session that names no computer, nothing is asked
  it('the direct road: the strip of a session that names its computer asks `direct.keep` for that computer — only inside the phone app', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    phoneCall.mockImplementation(async (type: string) => (type === 'shell.caps' ? { id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } } : type === 'direct.keep' ? { id: 'k', state: 'ready' } : { id: 'c', ok: false, code: 'bad_request' }));
    await render(); await act(async () => { await Promise.resolve(); });
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'direct.keep')).toEqual([['direct.keep', { setup_id: SETUP }]]);
  });

  it('the direct road: a session that names no computer, or a page outside the phone app, asks the shell nothing about a road', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: '' };
    phoneCall.mockImplementation(async () => ({ id: 'c', ok: false, code: 'bad_request' }));
    await render(); await act(async () => { await Promise.resolve(); });
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'direct.keep' || c[0] === 'direct.status')).toEqual([]);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    phone = false; sessionView = { ...sessionView, setup_id: SETUP }; phoneCall.mockClear(); await render(); await act(async () => { await Promise.resolve(); });
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'direct.keep' || c[0] === 'direct.status' || c[0] === 'direct.close' || c[0] === 'shell.caps')).toEqual([]); // (outside the phone app: not even the capability probe)
  });

  it('the phone app · a shell that says `records: 1` · a session that names its computer → [기록] sits with the other buttons', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    caps(1);
    await render();
    expect(recordsButton()?.textContent).toBe(ko.records.button);
    expect(buttons()).toEqual([ko.records.button, ko.button.stop, ko.button.instruct]);
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'shell.caps')).toHaveLength(2); // read ONCE by the strip's records button, and ONCE by the direct road's keeper (story 4993 · PO ⓐ: a different question, once per computer) — neither at every render
  });

  it('[기록] opens the sheet of THIS chat (its title and its lead) and reads through the shell\'s own words only', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    caps(1);
    await render();
    await act(async () => { recordsButton()!.click(); });
    await settle();
    expect(document.querySelector('[data-testid="agent-records-sheet"]')).not.toBeNull();
    expect(document.body.textContent).toContain(ko.records.title);
    expect(document.body.textContent).toContain(ko.records.lead);
    expect(document.querySelector('[data-testid="agent-records-computer"]')!.textContent).toBe(ko.records.computer.replace('{name}', 'SYJ-MacBook-Pro')); // whose history it is: the session's own computer
  });

  it('no button: an older shell (no `records`, or a word that is not 1) · a session that names no computer · the browser — and the browser never asks the shell', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    for (const records of [undefined, 0, 2, true, '1']) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      caps(records);
      await render();
      expect(recordsButton(), String(records)).toBeNull();
    }
    sessionView = { ...sessionView, setup_id: null };
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    caps(1);
    await render();
    expect(recordsButton()).toBeNull();
    sessionView = { ...sessionView, setup_id: SETUP };
    phone = false;
    phoneCall.mockClear();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    caps(1);
    await render();
    expect(recordsButton()).toBeNull();
    expect(phoneCall.mock.calls.filter((c) => c[0] === 'shell.caps')).toEqual([]);
  });

  it('the button goes when a later read of the session no longer names its computer (the shell\'s earlier answer is not enough)', async () => {
    vi.useFakeTimers();
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    caps(1);
    await render();
    expect(recordsButton()).not.toBeNull();
    sessionView = { ...sessionView, setup_id: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(recordsButton()).toBeNull();
  });

  it('a session that loses its computer and gets one back does not reopen the sheet by itself, and the button waits for the shell to say again', async () => {
    vi.useFakeTimers();
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP };
    caps(1);
    await render();
    await act(async () => { recordsButton()!.click(); });
    await settle();
    expect(document.querySelector('[data-testid="agent-records-sheet"]')).not.toBeNull();
    sessionView = { ...sessionView, setup_id: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(recordsButton()).toBeNull();
    expect(document.querySelector('[data-testid="agent-records-sheet"]')).toBeNull();
    let release: (v: unknown) => void = () => {};
    phoneCall.mockImplementation(() => new Promise((r) => { release = r; })); // the shell has not answered yet
    sessionView = { ...sessionView, setup_id: SETUP };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(recordsButton()).toBeNull(); // not before the shell says it again
    expect(document.querySelector('[data-testid="agent-records-sheet"]')).toBeNull();
    await act(async () => { release({ id: 'c', ok: true, caps: { records: 1 } }); });
    await settle();
    expect(recordsButton()).not.toBeNull();
    expect(document.querySelector('[data-testid="agent-records-sheet"]')).toBeNull(); // and the sheet stays shut
  });

  it('with no other button (the agent is idle) [기록] stands alone at the right end', async () => {
    server(res(201, {}));
    sessionView = { ...sessionView, setup_id: SETUP, state: 'idle' };
    caps(1);
    await render();
    expect(container.querySelector('[data-testid="agent-changes-buttons"] [data-testid="agent-records-open"]')).not.toBeNull();
  });
});

// story 4993 (5a): the strip names the computer the session runs on — the shell may take the press over the same-network direct road (and the server's POST is the road when it does not)
describe('[4993 5a] the strip and the direct road', () => {
  const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const shellAnswering = (extra: Record<string, unknown> = {}) => phoneCall.mockImplementation(async (type: string) => {
    if (type === 'command.sign') return { id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' };
    if (type === 'shell.caps') return { id: 'c', ok: true, caps: { direct: 1 } };
    if (type === 'direct.status') return { id: 's', ok: true, state: 'ready' };
    if (type === 'direct.send') return { id: 'x', ok: true, sent: true };
    if (type === 'direct.result') return { id: 'r', ok: true, state: 'done', ...extra };
    throw new Error(`unexpected ${type}`);
  });
  it('a session that names its computer: [멈춤] goes over the direct road — the shell is told which computer, and the server\'s command line is not posted to', async () => {
    vi.useFakeTimers(); sessionView = { ...sessionView, setup_id: SETUP };
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]); shellAnswering();
    await render(); await press(ko.button.stop); await poll(1);
    const send = phoneCall.mock.calls.find((c) => c[0] === 'direct.send')!; expect(send[1]).toMatchObject({ setup_id: SETUP, row: { kind: 'stop_session', session_key: 's-9', payload: { session_key: 's-9', signed: 'S' } } });
    expect(commandLine()?.textContent).toBe(ko.command.stopped);
    expect(calls.some((c) => c.init?.method === 'POST' && c.url.endsWith('/desktop-commands'))).toBe(false);
  });
  it('a session that does not name its computer: the shell is never asked about the road and the server gets the post as ever', async () => {
    vi.useFakeTimers(); const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]); shellAnswering();
    await render(); await press(ko.button.stop); await poll(1);
    expect(phoneCall.mock.calls.map((c) => c[0])).toEqual(['command.sign']); expect(calls.some((c) => c.init?.method === 'POST' && c.url.endsWith('/desktop-commands'))).toBe(true); expect(commandLine()?.textContent).toBe(ko.command.stopped);
  });
  it('the direct road refuses (a closed word): the same press is posted to the server with the same signature — the person sees the same line', async () => {
    vi.useFakeTimers(); sessionView = { ...sessionView, setup_id: SETUP };
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done' })]);
    phoneCall.mockImplementation(async (type: string) => (type === 'command.sign' ? { id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9' } : type === 'shell.caps' ? { id: 'c', ok: true, caps: { direct: 1 } } : type === 'direct.status' ? { id: 's', ok: true, state: 'ready' } : { id: 'x', ok: true, sent: false, why: 'ack' }));
    await render(); await press(ko.button.stop); await poll(1);
    expect(commandLine()?.textContent).toBe(ko.command.stopped); expect(calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith('/desktop-commands')).length).toBe(1);
  });
});
