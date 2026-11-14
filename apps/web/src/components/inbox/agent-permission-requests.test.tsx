// @vitest-environment jsdom
//
// story #4533 (명세 모음 B-2 · 웹은 읽기 전용) — the approvals inbox's «에이전트 권한 요청» group: the card (agent · computer ·
// role line · tool · masked summary with its notes · working folder) and one line where the buttons would be — the phone, the
// window passed, the computer gone quiet («연결 끊김 · 상태 모름» chip, no waiting time), no paired phone. No button at all on the web.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { PermissionPreview, PermissionRequest } from '@/lib/agent-permissions';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
let onNotice: ((n: { event_type: string; payload: Record<string, unknown> | null }) => void) | undefined;
let extraNames: string[] | undefined;
let onExtra: ((name: string, data: unknown) => void) | undefined;
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (o: { onNotification?: typeof onNotice; extraEventNames?: string[]; onExtraEvent?: typeof onExtra }) => {
    onNotice = o.onNotification; extraNames = o.extraEventNames; onExtra = o.onExtraEvent;
  },
}));
const { AgentPermissionRequests } = await import('./agent-permission-requests');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-03T14:00:00Z');
const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1', request_id: 'q1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: '개발',
  tool: 'Bash', summary: 'npm install --save ••••(가림) …', masked: true, truncated: true, workdir: '~/Sprintable/블로그 글',
  created_at: '2026-10-03T13:48:00Z', expires_at: '2026-10-03T14:30:00Z', state: 'pending', answered_by_name: null, decision: null,
  device_reachable: true, recipient_reason: 'paired', answerable: true, session_key: 's-1', input_hash: 'sha256:' + 'a'.repeat(64), ...over,
});
const answer = (requests: PermissionRequest[]) => new Response(JSON.stringify({ requests }), { status: 200 });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  fetchWithAuth.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentPermissionRequests />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
const line = () => container.querySelector('[data-testid="agent-permission-line"]')?.textContent;

describe('AgentPermissionRequests (story #4533)', () => {
  it('shows a waiting request as the spec card and says to answer on the paired phone — no button', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await render();
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/api/agent-permission-requests');
    for (const piece of ['에이전트 권한 요청 · 1', '권한 요청', '12분째 기다림', 'Dev · SYJ-MacBook-Pro', '개발 역할로 받은 요청이에요', 'Bash',
      'npm install --save •••• …', '비밀처럼 보이는 값은 가려서 보냈어요 · 앞 200자만 보여요', '작업 폴더 · ~/Sprintable/블로그 글']) {
      expect(text()).toContain(piece);
    }
    expect(line()).toBe('페어링된 폰에서 답할 수 있어요');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('[4949] a request that carries a preview shows its lines under the file name; one without shows none; the buttons stay (44 high on a phone)', async () => {
    const preview: PermissionPreview = { op: 'edit', blocks: [{ removed: ['a = 1'], added: ['a = 2'], removed_more: 0, added_more: 0 }], blocks_more: 0, replace_all: false, withheld: null };
    fetchWithAuth.mockResolvedValueOnce(answer([req({ tool: 'Edit', summary: 'src/a.ts', masked: false, preview }), req({ id: 'r2', request_id: 'q2', tool: 'Bash', summary: 'ls', masked: false })]));
    await render();
    const previews = container.querySelectorAll('[data-testid="agent-permission-preview"]');
    expect(previews).toHaveLength(1);
    expect(previews[0]!.textContent).toContain('바꾸려는 줄');
    expect(previews[0]!.textContent).toContain('a = 2');
    // the preview sits after the file name's box (the card reads: who · what tool · which file · which lines)
    const card = previews[0]!.closest('[data-testid="agent-permission-card"]')!;
    expect(card.textContent!.indexOf('src/a.ts')).toBeLessThan(card.textContent!.indexOf('바꾸려는 줄'));
  });

  it('[4949 · codex] once an answer was accepted the card shows no lines — a row still cached from before the answer is not a reason to keep a file\'s content on screen', async () => {
    const { PermissionCard } = await import('./agent-permission-requests');
    const preview: PermissionPreview = { op: 'edit', blocks: [{ removed: ['a = 1'], added: ['a = 2'], removed_more: 0, added_more: 0 }], blocks_more: 0, replace_all: false, withheld: null };
    const row = req({ tool: 'Edit', summary: 'src/a.ts', masked: false, preview });
    const mount = async (answerState: Parameters<typeof PermissionCard>[0]['answer']) => {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <PermissionCard request={row} now={NOW} phone auth={null} answer={answerState} onAnswer={() => {}} />
          </NextIntlClientProvider>,
        );
      });
    };
    await mount(null);
    expect(container.querySelector('[data-testid="agent-permission-preview"]')).not.toBeNull();
    for (const a of [{ kind: 'sending', decision: 'allow' }, { kind: 'answered', decision: 'allow' }, { kind: 'answered', decision: 'deny' }] as const) {
      await mount(a as never);
      expect(container.querySelector('[data-testid="agent-permission-preview"]'), a.kind).toBeNull();
    }
    await mount(null);
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><PermissionCard request={{ ...row, state: 'answered' }} now={NOW} phone auth={null} answer={null} onAnswer={() => {}} /></NextIntlClientProvider>); });
    expect(container.querySelector('[data-testid="agent-permission-preview"]'), 'a row that is no longer pending').toBeNull();
  });

  it('[4938] the masked block carries no word of its own: an older Mac app\'s «(가림)» is shown without it, a new one\'s «••••» as it is — and a file name beside the block stays', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ summary: '••••(가림).txt' }), req({ id: 'r2', request_id: 'q2', summary: '••••.txt' }), req({ id: 'r3', request_id: 'q3', summary: 'note.txt', masked: false }), req({ id: 'r4', request_id: 'q4', summary: 'echo ••••(가림)', masked: false })]));
    await render();
    const lines = [...container.querySelectorAll('p.font-mono')].map((n) => n.textContent);
    expect(lines).toEqual(['••••.txt', '••••.txt', 'note.txt', 'echo ••••(가림)']); // the last one the Mac did not mask: shown as it is
  });

  it('a quiet computer: «연결 끊김 · 상태 모름» and no waiting time; a passed window and no paired phone say why it cannot be answered here', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ device_reachable: false })]));
    await render();
    expect(text()).toContain('연결 끊김 · 상태 모름');
    expect(text()).not.toContain('분째 기다림');
    expect(line()).toBe('그 컴퓨터와 연결이 끊겨 지금 상태를 몰라요 — 다시 연결되면 여기서 바로 바뀌어요');

    fetchWithAuth.mockResolvedValueOnce(answer([req({ state: 'expired', expires_at: '2026-10-03T13:59:00Z' })]));
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();
    expect(line()).toBe('시간이 지나 여기서는 답할 수 없어요 — 그 컴퓨터의 터미널에서 답해 주세요');

    fetchWithAuth.mockResolvedValueOnce(answer([req({ recipient_reason: 'no_paired_phone', answerable: false })]));
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();
    expect(line()).toBe('그 컴퓨터와 페어링된 폰이 없어 여기서는 답할 수 없어요 — 그 컴퓨터의 터미널에서 답해 주세요');
  });

  it('nothing waiting (answered · withdrawn · long expired · empty · a failed read) draws nothing', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([
      req({ id: 'a', state: 'answered' }), req({ id: 'b', state: 'withdrawn' }),
      req({ id: 'c', state: 'expired', expires_at: '2026-10-03T12:00:00Z' }),
    ]));
    await render();
    expect(container.innerHTML).toBe('');
    fetchWithAuth.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('reads again while a request is shown, so the computer coming back changes the card', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ device_reachable: false })]));
    await render();
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(line()).toBe('페어링된 폰에서 답할 수 있어요');
  });

  // PO 11:23Z ③(나) — dev E2E: with the group empty, a new request did not show on the phone until the tab was opened again (its
  // notice never reached the page). The empty list is read on its own clock and when the page is seen again.
  it('nothing shown: a new request is drawn on the 30 s clock — no notice, no tab change', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    expect(container.innerHTML).toBe('');
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => { vi.advanceTimersByTime(29_999); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="agent-permission-requests"]')).not.toBeNull();
  });

  it('nothing shown: coming back to the page (the app in front again) reads at once', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="agent-permission-requests"]')).not.toBeNull();
  });

  it('a new request\'s bell notice reads at once — even with nothing shown — and other notices do not', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    expect(container.innerHTML).toBe('');
    await act(async () => { onNotice?.({ event_type: 'dispatched', payload: { event_type: 'conversation.message' } }); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => { onNotice?.({ event_type: 'dispatched', payload: { event_type: 'agent.permission_request' } }); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(line()).toBe('페어링된 폰에서 답할 수 있어요');
  });

  // story #4607: the server sends the notice as a NAMED frame `event: dispatched` (backend routers/events.py) — the hook passes it to
  // onExtraEvent only when 'dispatched' is among extraEventNames; its data is the frame (event_type · payload{event_type} …)
  it('a new request\'s notice arriving as the named `dispatched` frame reads at once — other dispatched kinds do not', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([]));
    await render();
    expect(extraNames).toContain('dispatched');
    await act(async () => { onExtra?.('dispatched', { event_id: 'e0', event_type: 'dispatched', payload: { event_type: 'conversation.message' } }); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(answer([req()]));
    await act(async () => {
      onExtra?.('dispatched', { event_id: 'e1', event_type: 'dispatched', source: { type: 'agent_permission_request', id: 'r1' }, payload: { event_type: 'agent.permission_request', title: 'Dev', body: 'Bash' } });
    });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(line()).toBe('페어링된 폰에서 답할 수 있어요');
  });

  it('reads in English', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ role: 'Developer' })]));
    await render('en');
    expect(text()).toContain('Agent permission requests · 1');
    expect(text()).toContain('Sent to the Developer role');
    expect(line()).toBe('You can answer from a paired phone');
  });
});

describe('[4532] the first read is never dropped for good', () => {
  it('React\'s development mode (each effect runs, is cleaned up, runs again at mount) still draws the group', async () => {
    fetchWithAuth.mockImplementation(async () => answer([req()])); // a fresh body per read
    await act(async () => {
      root.render(
        <StrictMode>
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <AgentPermissionRequests />
          </NextIntlClientProvider>
        </StrictMode>,
      );
    });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    // the first run's read is dropped by its cleanup — the second run reads again (it used to see «already read» and stop)
    expect(container.querySelector('[data-testid="agent-permission-requests"]')).not.toBeNull();
  });
});

// story 4542 (PO 02:04Z · Yuna 02:05Z): the card names the tool by the server's one rule (its row's tool_name in this language) —
// never the machine value of a known tool; a row from an older server (no tool_name) shows the value as it is; the computer once
describe('[SID:4542] the tool by its name · the computer once', () => {
  const tool = () => container.querySelector('[data-testid="agent-permission-tool"]')?.textContent;
  it('a Codex row: «명령 실행» (en «Run command»), never «commandExecution»', async () => {
    for (const locale of ['ko', 'en'] as const) {
      fetchWithAuth.mockResolvedValue(answer([req({ runtime: 'codex', tool: 'commandExecution', tool_name: { ko: '명\u2060령 실\u2060행', en: 'Run command' } })]));
      await render(locale);
      expect(tool()).toBe(locale === 'ko' ? '명\u2060령 실\u2060행' : 'Run command');
      expect(container.textContent).not.toContain('commandExecution');
    }
  });
  it('a row from an older server (no tool_name): the value as it is', async () => {
    fetchWithAuth.mockResolvedValue(answer([req({ tool: 'Bash' })]));
    await render();
    expect(tool()).toBe('Bash');
  });
  it('the computer once — only when the agent\'s name ends in exactly « · {computer}»', async () => {
    fetchWithAuth.mockResolvedValue(answer([req({ agent_name: 'Agent · SYJ-MacBook-Pro' }), req({ id: 'r2', request_id: 'q2', agent_name: 'Agent · OtherMac' })]));
    await render();
    const heads = [...container.querySelectorAll('[data-testid="agent-permission-card"] p.text-sm')].map((p) => p.textContent);
    expect(heads).toEqual(['Agent · SYJ-MacBook-Pro', 'Agent · OtherMac · SYJ-MacBook-Pro']);
  });
  // story 4580 AC2 (Yuna «4580 AC2» ① ②): the network question — first card with NO host (a muted line where the command box is), then
  // its second state with the host the daemon read from Claude's own hook text
  it('[4580 AC2 ①] the first card: «네트워크 연결» · the muted line · no host (even if the summary had one) · [허용…] [거부] on the phone', async () => {
    const net = () => container.querySelector('[data-testid="agent-permission-net"]');
    for (const locale of ['ko', 'en'] as const) {
      fetchWithAuth.mockResolvedValue(answer([req({ runtime: 'claude', tool: 'SandboxNetwork', summary: 'gitlab.com', stage: 'ask', host: null, tool_name: { ko: '네\u2060트\u2060워\u2060크 연\u2060결', en: 'Network connection' } })]));
      await render(locale);
      expect(net()?.textContent).toBe(locale === 'ko' ? '어디에 연결하려는지는 [허용…]을 누르면 보여요 — 보고 나서 정해요' : 'Press [Allow…] to see where it wants to connect — you decide after seeing it');
      expect(net()?.className).toContain('text-muted-foreground');
      expect(container.textContent).not.toContain('gitlab.com');
      expect(container.querySelector('p.font-mono')).toBeNull();
      expect(tool()).toBe(locale === 'ko' ? '네\u2060트\u2060워\u2060크 연\u2060결' : 'Network connection');
    }
  });
  it('[4580 AC2 ②] its second state: the host in the title · body · scope line (body font · no command box)', async () => {
    fetchWithAuth.mockResolvedValue(answer([req({ runtime: 'claude', tool: 'SandboxNetwork', summary: 'network', stage: 'confirm', host: 'gitlab.com' })]));
    await render();
    const box = container.querySelector('[data-testid="agent-permission-net-confirm"]');
    expect(box?.textContent).toContain('gitlab.com 연결을 허용하고 이어 갈까요');
    expect(box?.textContent).toContain('에이전트가 이 주소에 연결하려다 멈췄어요. 허용하면 이 에이전트의 허용 주소에 더하고, 에이전트에게 다시 해 보라고 넘겨요.');
    expect(box?.textContent).toContain('이 에이전트에만 · 이 주소만 허용돼요 — 에이전트 설정에서 뺄 수 있어요');
    expect(container.querySelector('p.font-mono')).toBeNull();
    expect(container.querySelector('[data-testid="agent-permission-net"]')).toBeNull();
  });
  it('[4580] the same value from another runtime is not it: its summary stays in the command box', async () => {
    const net = () => container.querySelector('[data-testid="agent-permission-net"]');
    fetchWithAuth.mockResolvedValue(answer([req({ runtime: 'codex', tool: 'SandboxNetwork', summary: 'gitlab.com' })]));
    await render();
    expect(net()).toBeNull();
    expect([...container.querySelectorAll('p.font-mono')].map((e) => e.textContent)).toContain('gitlab.com');
  });
});
