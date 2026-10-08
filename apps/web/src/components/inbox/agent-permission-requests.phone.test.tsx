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
  state: 'pending', answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true, session_key: 's-1', input_hash: `sha256:${'0'.repeat(64)}`, ...over,
});
const list = (requests: PermissionRequest[]) => new Response(JSON.stringify({ requests }), { status: 200 });

// the shell: answers each call from `shellAnswers` (a function of the call), records what the web sent
let sent: Array<{ type: string; args: Record<string, unknown> }> = [];
let shellAnswers: (type: string, args: Record<string, unknown>) => Record<string, unknown>;
function installShell() {
  window.__sprintablePhone = {
    claim(onReply) {
      delete window.__sprintablePhone;
      return (m) => {
        sent.push({ type: m.type, args: m.args });
        queueMicrotask(() => onReply({ id: m.id, ...shellAnswers(m.type, m.args) } as never));
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

  it('[4596 AC1] answered here: the result line until the next read, then gone — three answers on one open page leave no card', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      installShell();
      await render([req({ id: 'r1' }), req({ id: 'r2', request_id: 'q2' }), req({ id: 'r3', request_id: 'q3' })]);
      for (const _ of [1, 2, 3]) await press('거부'); // each card's [거부] in turn (an answered card shows its line, no buttons)
      expect(phoneLines()).toEqual(['거부됨 · Bash', '거부됨 · Bash', '거부됨 · Bash']); // right after: each with its line
      const reads = fetchWithAuth.mock.calls.length;
      fetchWithAuth.mockImplementation(async () => list([])); // the server drops answered requests
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await settle();
      expect(fetchWithAuth.mock.calls.length).toBe(reads + 1);
      expect(container.querySelectorAll('[data-testid="agent-permission-card"]').length).toBe(0); // the list is what waits
    } finally {
      vi.useRealTimers();
    }
  });

  it('[4596 AC1] a read that started before the answer does not take its card', async () => {
    const { afterRead } = await import('./agent-permission-requests');
    const row = req();
    const kept = new Map([[row.id, { row, answer: { kind: 'answered' as const, decision: 'deny' as const }, at: 2_000 }]]);
    expect(afterRead(kept, [], 1_000, 3_000).size).toBe(1); // that read began before the answer: it says nothing about it
    expect(afterRead(kept, [], 2_500, 3_000).size).toBe(0);
    const sending = new Map([[row.id, { row, answer: { kind: 'sending' as const, decision: 'deny' as const }, at: 2_000 }]]);
    expect(afterRead(sending, [], 2_500, 3_000).size).toBe(1); // still on its way
  });

  it('[4596 AC1 · 4580] the network question\'s first «allow…» waits for its request to come back (at most 2 min), not the next read', async () => {
    const { afterRead } = await import('./agent-permission-requests');
    const row = req({ tool: 'SandboxNetwork', runtime: 'claude', stage: 'ask' } as never);
    const kept = new Map([[row.id, { row, answer: { kind: 'answered' as const, decision: 'allow' as const }, at: 1_000 }]]);
    expect(afterRead(kept, [], 2_000, 2_000 + 60_000).size).toBe(1);
    expect(afterRead(kept, [], 2_000, 1_000 + 2 * 60_000).size).toBe(0);
    const denied = new Map([[row.id, { row, answer: { kind: 'answered' as const, decision: 'deny' as const }, at: 1_000 }]]);
    expect(afterRead(denied, [], 2_000, 2_500).size).toBe(0); // its [거부] ends it: no second card comes
  });

  it('[4596 AC2] «N분째 기다림» only on a card that still waits — not on one answered here, nor withdrawn · expired', async () => {
    installShell();
    await render([req({ id: 'r1' }), req({ id: 'r2', request_id: 'q2', state: 'expired', expires_at: new Date(Date.now() - 60_000).toISOString() })]);
    const waited = () => [...container.querySelectorAll('[data-testid="agent-permission-waited"]')].map((x) => x.textContent);
    expect(waited().length).toBe(1); // the pending one only
    await press('거부');
    expect(waited()).toEqual([]); // answered here: no «기다림»
    const { stillWaiting } = await import('./agent-permission-requests');
    expect(stillWaiting(req({ state: 'withdrawn' } as never), null)).toBe(false);
    expect(stillWaiting(req(), { kind: 'cancelled' })).toBe(true); // not confirmed on the OS prompt: it still waits
  });

  it('outside the phone app, or a request this phone cannot answer → the read-only line, no button', async () => {
    await render([req()]);
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="agent-permission-line"]')?.textContent).toBe('짝지은 폰에서 답할 수 있어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    installShell();
    await render([req({ answerable: false, session_key: null, input_hash: null })]); // a row this phone cannot answer carries no signing fields (4947): no buttons
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
    expect(phoneLines()).toEqual(['지문 · 얼굴이 꺼져 있어 화면 잠금으로 확인해요']);
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
    [{ ok: false, code: 'key_invalidated' }, '이 폰의 잠금 설정이 바뀌어 이 폰으로는 답할 수 없어요 — 이 폰을 컴퓨터와 다시 짝지어 주세요', ['다시 짝짓기']],
    // PO 07:47Z ①: the emulator's dead end — a key the server never knew was «보내지 못했어요 — 다시 눌러 주세요» forever
    [{ ok: false, code: 'not_registered' }, '이 폰은 이제 등록되어 있지 않아 답할 수 없어요 — 이 폰을 컴퓨터와 다시 짝지어 주세요', ['다시 짝짓기']], // Yuna 07:58Z
    // Kadir · PO 09:31Z ②: the shell's read had no session — sign in again; the request stays
    [{ ok: false, code: 'signed_out' }, '로그인이 풀려 보내지 못했어요 — 요청은 그대로예요. 다시 로그인한 뒤 눌러 주세요', ['다시 로그인']],
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
    // Yuna 07:48Z ①: a Korean line breaks between words, never inside one («주세 / 요» on the phone's width)
    expect(container.querySelector('[data-testid="agent-permission-phone-line"]')!.className).toMatch(/\bbreak-keep\b/);
  });

  it('signed out: [다시 로그인] goes to the sign-in page and back to this page (the request still waits there)', async () => {
    signAnswer = { ok: false, code: 'signed_out' };
    installShell();
    window.history.pushState({}, '', '/inbox?tab=gates');
    await render([req()]);
    await press('허용');
    const a = [...container.querySelectorAll('a')].find((x) => x.textContent === '다시 로그인');
    expect(a?.getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/inbox?tab=gates')}&reason=session_expired`);
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
    expect(phoneLines()).toEqual(['No fingerprint or face is set up, so your screen lock confirms it']);
    await press('Allow');
    expect(phoneLines()).toEqual(['Allowed · Bash']);
  });
});

// story #4580 AC2 (Yuna «4580 AC2» ① ② · 배치 ①' ②'): the network question on the phone — [허용…] first («주소를 확인하는 중…»), then
// the same card comes back with the host for a second answer; the first answer's line never stands on it
describe('[4580 AC2] the network question on the phone', () => {
  const net = (over: Partial<PermissionRequest> = {}) => req({ tool: 'SandboxNetwork', runtime: 'claude', summary: 'network', stage: 'ask', host: null, ...over });
  it('[허용…] → «주소를 확인하는 중…» · the second state comes with the host · its own buttons · [허용하고 이어 가기] → «허용됐어요 · {host} — …»', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      installShell();
      await render([net()]);
      expect(buttons()).toEqual(['허용…', '거부']);
      await press('허용…');
      expect(phoneLines()).toEqual(['주소를 확인하는 중…']);
      // the daemon reported the host: the next read brings the same request back at stage confirm
      fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? answerResponse() : list([net({ stage: 'confirm', host: 'gitlab.com' })])));
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await settle();
      expect(phoneLines()).toEqual([]); // «확인하는 중…» does not stand on the second card
      expect(buttons()).toEqual(['허용하고 이어 가기', '허용하지 않기']);
      expect(document.activeElement?.textContent).toBe('허용하지 않기'); // first focus: the side that keeps it closed
      await press('허용하고 이어 가기');
      expect(phoneLines()).toEqual(['허용됐어요 · gitlab.com — 에이전트에게 다시 해 보라고 넘겼어요']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('[거부] on the first card → «거부됨 · {tool}» · [허용하지 않기] on the second → «허용하지 않았어요»', async () => {
    installShell();
    await render([net()]);
    await press('거부');
    expect(phoneLines()).toEqual(['거부됨 · SandboxNetwork']);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render([net({ stage: 'confirm', host: 'gitlab.com' })]);
    await press('허용하지 않기');
    expect(phoneLines()).toEqual(['허용하지 않았어요']);
  });
});

describe('[4580 AC2 F2] the host could not be read', () => {
  it('[허용…] → «주소를 확인하는 중…» → the request ends host_unread → «주소를 확인하지 못해 이번 연결은 허용하지 못했어요», no buttons', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      installShell();
      const net = req({ tool: 'SandboxNetwork', runtime: 'claude', summary: 'network', stage: 'ask', host: null });
      await render([net]);
      await press('허용…');
      expect(phoneLines()).toEqual(['주소를 확인하는 중…']);
      fetchWithAuth.mockImplementation(async () => list([{ ...net, state: 'withdrawn', host_unread: true, answerable: false }]));
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await settle();
      expect(phoneLines()).toEqual(['주소를 확인하지 못해 이번 연결은 허용하지 못했어요']);
      expect(buttons()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// story #4604 (Yuna · 4596 AC4 run 13b · PO 20:06Z): the question's own words stand only while it asks — an answered · expired ·
// withdrawn card keeps its tool name and result line, never «[허용…]을 누르세요» or «{host}에 연결하려고 해요» with no button under it
describe('[4604] the question\'s words only while it asks', () => {
  const net = (over: Partial<PermissionRequest> = {}) => req({ tool: 'SandboxNetwork', runtime: 'claude', summary: 'network', stage: 'ask', host: null, ...over });
  const askLine = () => container.querySelector('[data-testid="agent-permission-net"]');
  const confirmBody = () => container.querySelector('[data-testid="agent-permission-net-confirm"]');
  const ko = koMessages.agentPermissions;
  const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(container); };

  it('the first card: the line while it asks → [거부] → only the tool and «거부됨 · …» (the D1 capture) · a press that comes back (cancelled) brings the buttons and the line back', async () => {
    installShell();
    await render([net()]);
    expect(askLine()?.textContent).toBe(ko.net.askLine);
    await press('거부');
    expect(phoneLines()).toEqual(['거부됨 · SandboxNetwork']);
    expect(buttons()).toEqual([]);
    expect(askLine()).toBeNull(); // mutant: the line drawn whatever the answer → RED
    expect(container.querySelector('[data-testid="agent-permission-tool"]')?.textContent).toBe('SandboxNetwork');
    // not confirmed on the OS prompt: the request still asks — its buttons and its words are back
    await remount();
    signAnswer = { ok: false, code: 'cancelled' };
    await render([net()]);
    await press('거부');
    expect(buttons()).toEqual(['허용…', '거부']);
    expect(askLine()?.textContent).toBe(ko.net.askLine);
  });

  it('the second card: «{host}에 연결하려고 해요» while it asks → [허용하지 않기] → only «허용하지 않았어요»', async () => {
    installShell();
    await render([net({ stage: 'confirm', host: 'gitlab.com' })]);
    expect(confirmBody()?.textContent).toContain('gitlab.com');
    await press('허용하지 않기');
    expect(phoneLines()).toEqual(['허용하지 않았어요']);
    expect(confirmBody()).toBeNull(); // mutant: the body drawn whatever the answer → RED
  });

  it('an expired card · a withdrawn one (host unread) — kept an hour — carry no line and no body, in the phone app and in a browser; a pending one in a browser keeps its line', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const phone of [true, false]) {
      await remount();
      if (phone) installShell();
      await render([
        net({ id: 'e1', state: 'expired', expires_at: past }),
        net({ id: 'w1', request_id: 'q2', state: 'withdrawn', host_unread: true, answerable: false }),
        net({ id: 'c1', request_id: 'q3', stage: 'confirm', host: 'gitlab.com', state: 'expired', expires_at: past }),
      ]);
      expect(container.querySelectorAll('[data-testid="agent-permission-card"]').length).toBe(3);
      expect(askLine()).toBeNull();
      expect(confirmBody()).toBeNull();
      __resetPhoneBridgeForTest();
    }
    await remount();
    await render([net()]); // a browser: the request still asks (answered on the phone) — its words stay
    expect(askLine()?.textContent).toBe(ko.net.askLine);
  });

  it('(Yuna 4987) pending, but no button can come — no word from the computer · no paired phone → no «press [허용…]» line, the card\'s own line says why', async () => {
    for (const phone of [true, false]) {
      for (const [over, says] of [
        [{ device_reachable: false }, koMessages.agentPermissions.line.unknown],
        [{ recipient_reason: 'no_paired_phone' }, koMessages.agentPermissions.line.noPairedPhone],
      ] as const) {
        await remount();
        if (phone) installShell();
        await render([net(over as Partial<PermissionRequest>)]);
        expect(askLine(), JSON.stringify(over)).toBeNull(); // mutant: «asking» alone → the line stands with no button → RED
        expect(container.querySelector('[data-testid="agent-permission-line"]')?.textContent).toBe(says);
        __resetPhoneBridgeForTest();
      }
    }
  });
});

// story #4610 (run13b 20:45Z · R13B-4580-10-unconfirmed.png): several cards of one agent looked alike with no time — the PO read the top
// one as the question just answered in the terminal. Every card now says when it was asked, in the waiting chip's place; a card that
// still waits keeps «{n}분째 기다림» (it says the same) and nothing more.
describe('[4610] when each card was asked', () => {
  const head = () => [...container.querySelectorAll('[data-testid="agent-permission-card"]')].map((c) => ({
    waited: c.querySelector('[data-testid="agent-permission-waited"]')?.textContent ?? null,
    asked: c.querySelector('[data-testid="agent-permission-asked"]')?.textContent ?? null,
  }));
  const ago = (min: number) => new Date(Date.now() - min * 60_000 - 5_000).toISOString();
  const past = () => new Date(Date.now() - 60_000).toISOString();
  const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(container); };

  it('each card shape: waiting → the chip only · expired · withdrawn · no word from the computer → «{n}분 전에 물음» — the phone app and a browser alike', async () => {
    for (const phone of [true, false]) {
      await remount();
      if (phone) installShell();
      await render([
        req({ id: 'p', created_at: ago(3) }),
        req({ id: 'e', request_id: 'q2', created_at: ago(7), state: 'expired', expires_at: past() }),
        req({ id: 'w', request_id: 'q3', tool: 'SandboxNetwork', runtime: 'claude', summary: 'network', stage: 'ask', host: null, created_at: ago(12), state: 'withdrawn', host_unread: true, answerable: false }),
        req({ id: 'u', request_id: 'q4', created_at: ago(20), device_reachable: false }),
      ]);
      expect(head(), `phone=${phone}`).toEqual([
        { waited: '3분째 기다림', asked: null }, // mutant: the time on every card → RED (two lines saying one thing)
        { waited: null, asked: '7분 전에 물음' }, // mutant: no asked line → RED
        { waited: null, asked: '12분 전에 물음' },
        { waited: null, asked: '20분 전에 물음' },
      ]);
      __resetPhoneBridgeForTest();
    }
  });

  it('answered here: the chip gives way to «{n}분 전에 물음» at once · in English «Asked {n} min ago»', async () => {
    installShell();
    await render([req({ created_at: ago(4) })]);
    expect(head()).toEqual([{ waited: '4분째 기다림', asked: null }]);
    await press('거부');
    expect(head()).toEqual([{ waited: null, asked: '4분 전에 물음' }]);
    await remount();
    await render([req({ state: 'expired', expires_at: past(), created_at: ago(2) })], 'en');
    expect(head()).toEqual([{ waited: null, asked: 'Asked 2 min ago' }]);
  });

  it('(Yuna 4990) under a minute: «방금 물음» · «Asked just now», never «0분 전에 물음»', async () => {
    const now = new Date(Date.now() - 5_000).toISOString();
    for (const [locale, says] of [['ko', '방금 물음'], ['en', 'Asked just now']] as const) {
      await remount();
      await render([req({ state: 'expired', expires_at: past(), created_at: now })], locale);
      expect(head(), locale).toEqual([{ waited: null, asked: says }]); // mutant: the plain «{n}분 전에 물음» → «0분 전에 물음» → RED
    }
  });
});


// story #4610 (Yuna `time-words.md` · the board's relativeTime steps): both chips say the age in one unit — «방금» under 60 s, then whole
// minutes · hours · days, rounded down. The nine rows of §3 are the expected values, the bounds exactly.
describe('[4610] time in steps (Yuna time-words.md §3)', () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  // [age ms, ko waited, en waited, ko asked, en asked]
  const ROWS: Array<[number, string, string, string, string]> = [
    [5 * S, '방금 물음', 'Asked just now', '방금 물음', 'Asked just now'],
    [59 * S, '방금 물음', 'Asked just now', '방금 물음', 'Asked just now'],
    [1 * M, '1분째 기다림', 'Waiting 1 min', '1분 전에 물음', 'Asked 1 min ago'],
    [59 * M + 59 * S, '59분째 기다림', 'Waiting 59 min', '59분 전에 물음', 'Asked 59 min ago'],
    [1 * H, '1시간째 기다림', 'Waiting 1 h', '1시간 전에 물음', 'Asked 1 h ago'],
    [11 * H + 24 * M, '11시간째 기다림', 'Waiting 11 h', '11시간 전에 물음', 'Asked 11 h ago'], // run 13's «684분째»
    [23 * H + 59 * M, '23시간째 기다림', 'Waiting 23 h', '23시간 전에 물음', 'Asked 23 h ago'],
    [24 * H, '1일째 기다림', 'Waiting 1 d', '1일 전에 물음', 'Asked 1 d ago'],
    [3 * D + 5 * H, '3일째 기다림', 'Waiting 3 d', '3일 전에 물음', 'Asked 3 d ago'],
  ];

  it('each row, at its exact age: ageParts → the ko · en copy of both keys (the real message files, parsed)', async () => {
    const { ageParts } = await import('@/lib/agent-permissions');
    const { createTranslator } = await import('next-intl');
    type T = (k: string, v?: Record<string, string | number>) => string;
    const ko = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'agentPermissions' }) as unknown as T;
    const en = createTranslator({ locale: 'en', messages: enMessages, namespace: 'agentPermissions' }) as unknown as T;
    for (const [ms, koW, enW, koA, enA] of ROWS) {
      const p = ageParts(ms);
      // mutant: a bound off by one (≤ 60 s · ≤ 60 min · ≤ 24 h) or minutes only → a row RED
      expect([ko('waited', p), en('waited', p), ko('asked', p), en('asked', p)], `${ms} ms`).toEqual([koW, enW, koA, enA]);
    }
    expect(ageParts(-5 * S)).toEqual({ unit: 's', n: 0 }); // a clock a little behind the server's: never a negative age
  });

  it('on the card: a waiting chip and an asked line of the same age (away from the bounds) · ko and en', async () => {
    const remount = async () => { await act(async () => { root.unmount(); }); root = createRoot(container); };
    const text = (id: string) => container.querySelector(`[data-testid="agent-permission-${id}"]`)?.textContent ?? null;
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const [ms, koW, enW, koA, enA] of [ROWS[0], ROWS[5], ROWS[8]]) {
      for (const [locale, w, a] of [['ko', koW, koA], ['en', enW, enA]] as const) {
        await remount();
        const created = new Date(Date.now() - ms).toISOString();
        await render([req({ id: 'p', created_at: created, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }),
          req({ id: 'e', request_id: 'q2', created_at: created, state: 'expired', expires_at: past })], locale);
        expect([text('waited'), text('asked')], `${ms} ${locale}`).toEqual([w, a]);
      }
    }
  });
});

describe('[4590] a question only that computer\'s terminal answers (Yuna 4590-terminal-only-card.md §1 · §6)', () => {
  const terminal = (over: Partial<PermissionRequest> = {}) =>
    req({ terminal_only: true, answerable: false, session_key: null, input_hash: null, ...over });
  const line = () => container.querySelector('[data-testid="agent-permission-line"]')?.textContent;

  it('the line order, one table: expired > unknown > terminalOnly > noPairedPhone > answerOnPhone', async () => {
    const { permissionLine } = await import('@/lib/agent-permissions');
    const rows: Array<[Partial<PermissionRequest>, string]> = [
      [{ state: 'expired', terminal_only: true, device_reachable: false, recipient_reason: 'no_paired_phone' }, 'expired'],
      [{ terminal_only: true, device_reachable: false, recipient_reason: 'no_paired_phone' }, 'unknown'],
      [{ terminal_only: true, recipient_reason: 'no_paired_phone' }, 'terminalOnly'], // not noPairedPhone: no phone answers it anyway
      [{ terminal_only: true }, 'terminalOnly'],
      [{ recipient_reason: 'no_paired_phone' }, 'noPairedPhone'],
      [{}, 'answerOnPhone'],
      [{ terminal_only: false }, 'answerOnPhone'],
    ];
    expect(rows.map(([over]) => permissionLine(req(over)))).toEqual(rows.map(([, want]) => want));
  });

  it('inside the phone app: the card with its chip and wait, no button, the terminal line — never the phone lines', async () => {
    installShell();
    await render([terminal({ recipient_reason: 'no_paired_phone' })]);
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="agent-permission-card"]')?.textContent).toContain('권한 요청');
    expect(container.querySelector('[data-testid="agent-permission-waited"]')?.textContent).toBe('1분째 기다림');
    expect(line()).toBe('이 물음은 그 컴퓨터의 터미널에서만 답할 수 있어요');
    expect(container.textContent).not.toContain('짝지은 폰');
    expect(container.querySelector('[data-testid="agent-permission-tool"]')?.textContent).toBe('Bash'); // read: named as ever
    expect(container.querySelector('[data-testid="agent-permission-tool-unread"]')).toBeNull();
  });

  it('a tool not read: where to see it in its place, no summary box, no made-up name', async () => {
    await render([terminal({ tool: null, tool_name: null, summary: null })]);
    expect(container.querySelector('[data-testid="agent-permission-tool"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-permission-tool-unread"]')?.textContent).toBe('무엇을 묻는지는 그 컴퓨터의 터미널에서 볼 수 있어요');
    expect(container.querySelector('.font-mono')).toBeNull();
    expect(line()).toBe('이 물음은 그 컴퓨터의 터미널에서만 답할 수 있어요');
  });

  it('reads in English', async () => {
    await render([terminal({ tool: null, tool_name: null, summary: null })], 'en');
    expect(container.querySelector('[data-testid="agent-permission-tool-unread"]')?.textContent).toBe("What it asks is shown in that computer's terminal");
    expect(line()).toBe("This question can only be answered in that computer's terminal");
  });
});
