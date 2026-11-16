// @vitest-environment jsdom
//
// story 4972 — a SEALED request (an envelope only the paired phone opens: the server holds no summary · tool · preview): the card shows one locked line,
// inside the phone app one [앱에서 열기] (answerable → the shell's sheet answers · terminal-only → the shell's read-only sheet), in a browser the line «폰 앱에서 열어 보세요».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { PermissionRequest } from '@/lib/agent-permissions';
import { __resetPhoneBridgeForTest, claimPhoneBridge } from '@/lib/phone-bridge';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

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
      <PhoneBridgeClaim><NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentPermissionRequests />
      </NextIntlClientProvider></PhoneBridgeClaim>,
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


const sealedReq = (over: Partial<PermissionRequest> = {}) => req({ tool: null, summary: null, sealed: true, ...over });
const sealedText = () => container.querySelector('[data-testid="agent-permission-sealed"]')?.textContent ?? null;

describe('[4972] a sealed card', () => {
  it('inside the phone app: the locked line · no tool line · no summary · one [앱에서 열기]', async () => {
    installShell();
    await render([sealedReq()]);
    expect(sealedText()).toBe('내용이 잠겨 있어요');
    expect(container.querySelector('[data-testid="agent-permission-tool-unread"]')).toBeNull(); // «what it asks is in the terminal» is not true of a sealed card
    expect(container.querySelector('[data-testid="agent-permission-tool"]')).toBeNull();
    expect(buttons()).toEqual(['앱에서 열기']);
  });

  it('[앱에서 열기] → approval.sign {id, decision} (the shell\'s sheet answers) → the web posts the decision the shell SIGNED → «허용했어요» (no tool named)', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: true, signed: 'SIGNED', phone_key_id: 'k-1', decision: 'allow' });
    installShell();
    await render([sealedReq()]);
    await press('앱에서 열기');
    expect(sent.find((s) => s.type === 'approval.sign')!.args.id).toBe('r1');
    const post = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ decision: 'allow', signed: 'SIGNED', phone_key_id: 'k-1' });
    expect(phoneLines()).toEqual(['허용했어요']);
  });

  it('the person denied on the sheet → «거부했어요» and a deny is posted', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: true, signed: 'SIGNED', phone_key_id: 'k-1', decision: 'deny' });
    installShell();
    await render([sealedReq()]);
    await press('앱에서 열기');
    const post = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string).decision).toBe('deny');
    expect(phoneLines()).toEqual(['거부했어요']);
  });

  it('lens 807 low 2 — the shell\'s vault_unavailable → «잠시 뒤 다시» with the button back · card_refused → the terminal line, no button', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'vault_unavailable' });
    installShell();
    await render([sealedReq()]);
    await press('앱에서 열기');
    expect(fetchWithAuth.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
    expect(buttons()).toEqual(['앱에서 열기']);
    expect(phoneLines()).toEqual(['폰이 아직 준비되지 않았어요 — 잠시 뒤 다시 눌러 주세요. 요청은 그대로예요']);
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'card_refused' });
    await press('앱에서 열기');
    expect(buttons()).toEqual([]);
    expect(phoneLines()).toEqual(['이 폰에서는 이 요청을 열 수 없어요 — 요청은 그대로예요. 그 컴퓨터의 터미널에서 답해 주세요']);
  });

  it('the person closed the sheet → nothing posted, the button comes back with «보내지 않았어요»', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'cancelled' });
    installShell();
    await render([sealedReq()]);
    await press('앱에서 열기');
    expect(fetchWithAuth.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
    expect(buttons()).toEqual(['앱에서 열기']);
    expect(phoneLines()).toEqual(['보내지 않았어요 — 요청은 그대로예요']);
  });

  it('a terminal-only sealed card: [앱에서 열기] calls approval.view {id} (read only) and keeps the terminal line', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: true });
    installShell();
    await render([sealedReq({ answerable: false, terminal_only: true, input_hash: null, session_key: null })]);
    expect(buttons()).toEqual(['앱에서 열기']);
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toBe('이 물음은 그 컴퓨터의 터미널에서만 답할 수 있어요');
    await press('앱에서 열기');
    expect(sent.find((s) => s.type === 'approval.view')).toEqual({ type: 'approval.view', args: { id: 'r1' } });
    expect(sent.some((s) => s.type === 'approval.sign')).toBe(false);
  });

  it('a terminal-only sealed card whose view fails says why — not ready · cannot open · plain failure; one already closed shows «더 이상 답할 수 없어요»', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'vault_unavailable' });
    installShell();
    await render([sealedReq({ answerable: false, terminal_only: true, input_hash: null, session_key: null })]);
    await press('앱에서 열기');
    expect(phoneLines()).toEqual(['폰이 아직 준비되지 않았어요 — 잠시 뒤 다시 눌러 주세요. 요청은 그대로예요']);
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'card_refused' });
    await press('앱에서 열기');
    expect(phoneLines()).toEqual(['이 폰에서는 이 요청을 열 수 없어요 — 요청은 그대로예요. 그 컴퓨터의 터미널에서 답해 주세요']);
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'timeout' });
    await press('앱에서 열기');
    expect(phoneLines()).toEqual(['보내지 못했어요 — 요청은 그대로예요. 다시 눌러 주세요']);
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: false, code: 'not_pending' });
    await press('앱에서 열기');
    expect(phoneLines()).toEqual(['이 요청에는 더 이상 답할 수 없어요']);
  });

  it('a sealed terminal-only card still opens when the computer has gone quiet or remote control is off — and the line stays the true one', async () => {
    shellAnswers = (type) => (type === 'device.auth' ? { ok: true, auth } : { ok: true });
    installShell();
    const base = { answerable: false, terminal_only: true, input_hash: null, session_key: null };
    await render([sealedReq({ ...base, device_reachable: false })]);
    expect(buttons()).toEqual(['앱에서 열기']);
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toContain('연결이 끊겨');
    await press('앱에서 열기');
    expect(sent.find((s) => s.type === 'approval.view')).toEqual({ type: 'approval.view', args: { id: 'r1' } });
    await act(async () => { root.render(<div />); });
    await render([sealedReq({ ...base, remote_control_off: true })]);
    expect(buttons()).toEqual(['앱에서 열기']);
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toContain('원격 제어가 꺼져');
  });

  it('in a browser (no phone app): the locked line + «폰 앱에서 열어 보세요», no button', async () => {
    await render([sealedReq()]);
    expect(sealedText()).toBe('내용이 잠겨 있어요');
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toBe('폰 앱에서 열어 보세요');
    expect(buttons()).toEqual([]);
  });

  it('English copy', async () => {
    await render([sealedReq()], 'en');
    expect(sealedText()).toBe('The content is locked');
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toBe('Open it in the phone app');
  });

  it('a plain card is exactly as before (the sealed branches do not touch it)', async () => {
    installShell();
    await render([req()]);
    expect(sealedText()).toBeNull();
    expect(buttons()).toEqual(['허용', '거부']);
  });

  it('the other lines (no paired phone · computer gone quiet) still win in a browser — the locked line does not replace them', async () => {
    await render([sealedReq({ recipient_reason: 'no_paired_phone', answerable: false })]);
    expect(container.querySelector('[data-testid="agent-permission-line"]')!.textContent).toContain('페어링된 폰이 없어');
    expect(sealedText()).toBe('내용이 잠겨 있어요');
  });
});
