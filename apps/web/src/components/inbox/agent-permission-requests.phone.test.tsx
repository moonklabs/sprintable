// @vitest-environment jsdom
//
// story #4532 (명세 B-2 · «폰 서명 · 권한 창 문구» ③) — the approvals card inside the phone app: [허용] · [거부] only when the
// shell's bridge was claimed and the request is answerable · the web passes `{id, decision}` only · one line in the button place
// for each way it ends · the advance lines for a phone without biometrics or a screen lock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { PermissionRequest } from '@/lib/agent-permissions';
import { __resetPhoneBridgeForTest, claimPhoneBridge } from '@/lib/phone-bridge';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => {} }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { AgentPermissionRequests } = await import('./agent-permission-requests');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1', request_id: 'q1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: '개발',
  tool: 'Bash', summary: 'npm install', masked: false, truncated: false, workdir: null,
  created_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  state: 'pending', answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true, ...over,
});
const list = (requests: PermissionRequest[]) => new Response(JSON.stringify({ requests }), { status: 200 });

// the shell: answers each call from `shellAnswers` (a function of the call), records what the web sent
let sent: Array<{ type: string; args: Record<string, unknown> }> = [];
let shellAnswers: (type: string, args: Record<string, unknown>) => Record<string, unknown>;
function installShell() {
  window.__sprintablePhone = {
    claim() {
      delete window.__sprintablePhone;
      return (m) => {
        sent.push({ type: m.type, args: m.args });
        queueMicrotask(() => window.__sprintablePhoneReply?.({ id: m.id, ...shellAnswers(m.type, m.args) } as never));
      };
    },
  };
  claimPhoneBridge();
}
let auth = 'biometric';
let signAnswer: Record<string, unknown> = { ok: true, signed: 'SIGNED', phone_key_id: 'k-1' };
let answerResponse: () => Response = () => new Response(JSON.stringify({ state: 'answered' }), { status: 200 });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sent = [];
  auth = 'biometric';
  signAnswer = { ok: true, signed: 'SIGNED', phone_key_id: 'k-1' };
  answerResponse = () => new Response(JSON.stringify({ state: 'answered' }), { status: 200 });
  shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : type === 'approval.sign' ? signAnswer : { ok: true });
  fetchWithAuth.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  __resetPhoneBridgeForTest();
  delete window.__sprintablePhone;
  delete window.__sprintablePhoneReply;
});

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function render(rows: PermissionRequest[], locale: 'ko' | 'en' = 'ko') {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answerResponse();
    if (url === '/api/agent-permission-requests') return list(rows);
    throw new Error(`unexpected ${url}`);
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentPermissionRequests />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
const buttons = () => [...container.querySelectorAll('button, a')].map((b) => b.textContent);
const phoneLines = () => [...container.querySelectorAll('[data-testid="agent-permission-phone-line"]')].map((p) => p.textContent);
const press = async (label: string) => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}: ${buttons().join(',')}`);
  await act(async () => { b.click(); });
  await settle();
};

describe('[4532] approvals card inside the phone app', () => {
  it('[허용] → the shell gets {id, decision} only → the shell\'s signed goes to the answer route → «허용됨 · Bash», buttons gone', async () => {
    installShell();
    await render([req()]);
    expect(buttons()).toEqual(['허용', '거부']);
    expect(container.querySelector('[data-testid="agent-permission-line"]')).toBeNull();
    await press('허용');
    expect(sent.find((s) => s.type === 'approval.sign')).toEqual({ type: 'approval.sign', args: { id: 'r1', decision: 'allow' } });
    const post = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/api/agent-permission-requests/r1/answer');
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ decision: 'allow', signed: 'SIGNED', phone_key_id: 'k-1' });
    expect(phoneLines()).toEqual(['허용됨 · Bash']);
    expect(buttons()).toEqual([]);
    expect(document.activeElement?.textContent).toBe('허용됨 · Bash'); // the result takes the pressed button's focus
  });

  it('stays with its line after the list drops the answered request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      installShell();
      await render([req()]);
      await press('거부');
      expect(phoneLines()).toEqual(['거부됨 · Bash']);
      const reads = fetchWithAuth.mock.calls.length;
      fetchWithAuth.mockImplementation(async () => list([]));
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await settle();
      expect(fetchWithAuth.mock.calls.length).toBe(reads + 1); // the list was read again — and came back empty
      expect(phoneLines()).toEqual(['거부됨 · Bash']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('outside the phone app, or a request this phone cannot answer → the read-only line, no button', async () => {
    await render([req()]);
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="agent-permission-line"]')?.textContent).toBe('짝지은 폰에서 답할 수 있어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    installShell();
    await render([req({ answerable: false })]);
    expect(buttons()).toEqual([]);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render([req({ device_reachable: false })]);
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="agent-permission-line"]')?.textContent).toContain('연결이 끊겨');
  });

  it('no biometrics on a phone with a screen lock: the buttons stay, with one line that the screen lock confirms', async () => {
    auth = 'screen_lock';
    installShell();
    await render([req()]);
    expect(buttons()).toEqual(['허용', '거부']);
    expect(phoneLines()).toEqual(['지문 · 얼굴이 꺼져 있어 화면 잠금(PIN 등)으로 확인해요']);
    expect(document.activeElement).toBe(document.body); // a line drawn before any press takes no focus
  });

  it('fingerprint-only phone with none enrolled · no screen lock: the line and [설정 열기] instead of the buttons — back from settings, the buttons return', async () => {
    for (const [state, text] of [
      ['biometric_required', '이 폰은 지문으로만 답할 수 있어요 — 폰 설정에서 지문을 등록한 뒤 다시 눌러 주세요'],
      ['no_screen_lock', '화면 잠금이 없는 폰에서는 답할 수 없어요 — 폰 설정에서 화면 잠금을 켜 주세요'],
    ]) {
      auth = state;
      __resetPhoneBridgeForTest();
      installShell();
      await render([req()]);
      expect(phoneLines()).toEqual([text]);
      expect(buttons()).toEqual(['설정 열기']);
      await press('설정 열기');
      expect(sent.at(-1)).toEqual({ type: 'app.settings', args: {} });
      auth = 'biometric';
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await settle();
      expect(buttons()).toEqual(['허용', '거부']);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  it.each([
    [{ ok: false, code: 'cancelled' }, '보내지 않았어요 — 요청은 그대로예요', ['허용', '거부']],
    [{ ok: false, code: 'key_invalidated' }, '이 폰의 지문 · 얼굴 설정이 바뀌어 이 폰으로는 답할 수 없어요 — 이 폰을 컴퓨터와 다시 짝지어 주세요', ['다시 짝짓기']],
    [{ ok: false, code: 'biometric_required' }, '이 폰은 지문으로만 답할 수 있어요 — 폰 설정에서 지문을 등록한 뒤 다시 눌러 주세요', ['설정 열기']],
    [{ ok: false, code: 'not_pending' }, '이 요청에는 더 이상 답할 수 없어요', []],
    [{ ok: false, code: 'sign_failed' }, '보내지 못했어요 — 요청은 그대로예요. 다시 눌러 주세요', ['허용', '거부']],
  ])('the shell answers %j → its line and what can still be pressed', async (answer, text, left) => {
    signAnswer = answer;
    installShell();
    await render([req()]);
    await press('허용');
    expect(phoneLines()).toEqual([text]);
    expect(buttons()).toEqual(left);
    expect(fetchWithAuth.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('a sign refused for no fingerprint: back from settings able to confirm → the buttons return', async () => {
    signAnswer = { ok: false, code: 'biometric_required' };
    installShell();
    await render([req()]);
    await press('허용');
    expect(buttons()).toEqual(['설정 열기']);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); // auth reads «biometric»
    await settle();
    expect(buttons()).toEqual(['허용', '거부']);
    expect(phoneLines()).toEqual([]);
  });

  it('a sign refused for no fingerprint: still unable to confirm → the line and [설정 열기] stay', async () => {
    signAnswer = { ok: false, code: 'biometric_required' };
    installShell();
    await render([req()]);
    await press('허용');
    auth = 'biometric_required';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(phoneLines()).toEqual(['이 폰은 지문으로만 답할 수 있어요 — 폰 설정에서 지문을 등록한 뒤 다시 눌러 주세요']);
    expect(buttons()).toEqual(['설정 열기']);
  });

  it('[다시 짝짓기] goes to the pairing screen', async () => {
    signAnswer = { ok: false, code: 'key_invalidated' };
    installShell();
    await render([req()]);
    await press('허용');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/desktop/pair');
  });

  it.each([
    [409, { error: { code: 'phone_not_paired' } }, '이 폰은 그 컴퓨터와 짝지어 있지 않아 보내지 못했어요 — 요청은 그대로예요. 짝지은 폰이나 그 컴퓨터의 터미널에서 답해 주세요'],
    [409, { error: { code: 'already_answered' }, detail: { answered_by_name: 'Jay', decision: 'deny' } }, 'Jay님이 거부함'],
    [409, { error: { code: 'already_answered' } }, '이미 다른 곳에서 답한 요청이에요'],
    [410, { error: { code: 'expired' } }, '시간이 지나 여기서는 답할 수 없어요 — 그 컴퓨터의 터미널에서 답해 주세요'],
    [410, { error: { code: 'withdrawn' } }, '이 요청에는 더 이상 답할 수 없어요'],
    [409, { error: { code: 'device_unreachable' } }, '그 컴퓨터와 연결이 끊겨 지금 상태를 몰라요 — 다시 연결되면 여기서 바로 바뀌어요'],
  ])('the server answers %i %j → its line, no buttons', async (status, body, text) => {
    answerResponse = () => new Response(JSON.stringify(body), { status });
    installShell();
    await render([req()]);
    await press('허용');
    expect(phoneLines()).toEqual([text]);
    expect(buttons()).toEqual([]);
  });

  it('reads in English', async () => {
    auth = 'screen_lock';
    installShell();
    await render([req()], 'en');
    expect(buttons()).toEqual(['Allow', 'Deny']);
    expect(phoneLines()).toEqual(['No fingerprint or face is set up, so your screen lock (PIN etc.) confirms it']);
    await press('Allow');
    expect(phoneLines()).toEqual(['Allowed · Bash']);
  });
});
