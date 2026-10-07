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

const AGENT = '22222222-3333-4444-8555-666666666666';
const CONV = '33333333-4444-4555-8666-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => {} }));
let phone = true;
const phoneCall = vi.fn();
vi.mock('@/lib/phone-bridge', () => ({ isPhoneApp: () => phone, phoneCall: (...a: unknown[]) => phoneCall(...a) }));
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
  phoneCall.mockReset();
  fetchWithAuth.mockReset();
  sessionView = { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, can_command: true, pending_permission_request_id: null, instruct_now: true };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { vi.useRealTimers(); await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

async function settle(n = 6) { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); }
async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentSessionStrip agentId={AGENT} conversationId={CONV} />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
const buttons = () => [...container.querySelectorAll('[data-testid="agent-session-buttons"] button')].map((b) => b.textContent);
const press = async (name: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === name) as HTMLButtonElement | undefined;
  if (!b) throw new Error(`no button ${name}`);
  await act(async () => { b.click(); });
  await settle();
};
const commandLine = () => container.querySelector('[data-testid="agent-command-line"]');
const ko = koMessages.chats.agentSession;
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

  it('[지금 지시]: the sheet (title · note) → [보내기] → the shell gets the text and this conversation → «… 단계를 마치면 바로 들어가요» · the draft goes', async () => {
    vi.useFakeTimers();
    const calls = server(res(201, { command_id: CMD, state: 'queued' }), [res(200, { state: 'done', result_code: 'after_step' })]);
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    expect(document.body.textContent).toContain(ko.sheet.title);
    expect(document.body.textContent).toContain(ko.sheet.note);
    const box = document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement;
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
    expect((document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement).value).toBe('');
  });

  it('the turn had ended (409): the instruction goes in as a message into this conversation — never lost', async () => {
    const calls = server(res(409, { error: { code: 'session_not_working' } }));
    phoneCall.mockResolvedValue({ id: 'w', ok: true, signed: 'S', phone_key_id: 'k-1', session_key: 's-9', text: 'run the tests' });
    await render();
    await press(ko.button.instruct);
    const box = document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'run the tests'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await press(ko.sheet.send);
    await settle();
    expect(commandLine()?.textContent).toBe(ko.command.sentAsMessage);
    const msg = calls.find((c) => c.url === `/api/conversations/${CONV}/messages`)!;
    expect(JSON.parse(msg.init!.body as string)).toEqual({ content: 'run the tests' });
  });

  const typeAndSend = async (text: string) => {
    await press(ko.button.instruct);
    const box = document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement;
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
    expect(phoneCall).toHaveBeenCalledTimes(1);
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
    expect((document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement).value).toBe('x');
  });

  it('refusals keep the button\'s verb and their way out: signed out → [다시 로그인] · key lost → [다시 짝짓기] · no screen lock → [설정 열기]', async () => {
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
      const box = document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'x'); box.dispatchEvent(new Event('input', { bubbles: true })); });
      await press(ko.sheet.send);
      expect(commandLine()?.textContent).toBe(sendLine);
      expect(commandLine()?.className).toContain('break-keep');
      await press(ko.button.instruct);
      expect((document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement).value, `${code}: what was written stays`).toBe('x');
    }
    expect(fetchWithAuth.mock.calls.some(([u, i]) => String(u).endsWith('/desktop-commands') && (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
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
    const box = document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement;
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
    expect((document.querySelector('[data-testid="agent-instruct-text"]') as HTMLTextAreaElement).value).toHaveLength(401);
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
});
