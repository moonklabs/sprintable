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
});
