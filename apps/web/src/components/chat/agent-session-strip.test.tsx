// @vitest-environment jsdom
//
// story #4534 (명세 모음 B-3 · «상태 칩 ↔ 서버 세션 상태») — the agent's session in its DM: six states with the desktop bar's
// words and shapes, one line where the phone's buttons would be (working: the phone · off: why · unknown: the lost line ·
// waiting: the inbox link · the rest: none). No button on the web. Reads again on its own `desktop.session_changed`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
let onExtra: ((name: string, data: unknown) => void) | undefined;
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (o: { onExtraEvent?: typeof onExtra }) => { onExtra = o.onExtraEvent; },
}));
const { AgentSessionStrip } = await import('./agent-session-strip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({
  device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, pending_permission_request_id: null, ...over,
}), { status: 200 });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { fetchWithAuth.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentSessionStrip agentId="a-1" />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const chip = () => container.querySelector('[data-testid="agent-session-chip"]')?.textContent;
const line = () => container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? null;

describe('AgentSessionStrip (story #4534)', () => {
  it.each([
    ['starting', '시작됨', null],
    ['working', '작업 중', '짝지은 폰에서 멈추거나 지시할 수 있어요'],
    ['idle', '다음 일 기다림', null],
    ['waiting_permission', '권한 대기', '결재함에서 답할 수 있어요'],
    ['stopped', '끝', null],
    ['unknown', '상태 모름', '그 컴퓨터와 연결이 끊겨 지금 상태를 몰라요 — 다시 연결되면 여기서 바로 바뀌어요'],
  ])('%s → «%s» and its line, no button', async (state, word, expected) => {
    fetchWithAuth.mockResolvedValueOnce(view({ state }));
    await render();
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/api/agents/a-1/desktop-session');
    expect(chip()).toBe(word);
    expect(line()).toBe(expected);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('working with remote control off says why; not on a computer draws nothing', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ remote_control: false }));
    await render();
    expect(line()).toBe('이 조직은 원격 제어를 꺼 두었어요 — 그 컴퓨터에서 직접 해 주세요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: null }));
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('reads again on its own agent\'s nudge only, and the computer gone quiet shows «상태 모름»', async () => {
    fetchWithAuth.mockResolvedValueOnce(view());
    await render();
    await act(async () => { onExtra?.('desktop.session_changed', JSON.stringify({ agent_member_id: 'other' })); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'unknown' }));
    await act(async () => { onExtra?.('desktop.session_changed', JSON.stringify({ agent_member_id: 'a-1' })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(chip()).toBe('상태 모름');
  });

  it('reads in English', async () => {
    fetchWithAuth.mockResolvedValueOnce(view());
    await render('en');
    expect(chip()).toBe('Working');
    expect(line()).toBe('You can stop or instruct it from a paired phone');
  });
});
