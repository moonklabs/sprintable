// @vitest-environment jsdom
//
// story #4533 (명세 모음 B-2 · 웹은 읽기 전용) — the approvals inbox's «에이전트 권한 요청» group: the card (agent · computer ·
// role line · tool · masked summary with its notes · working folder) and one line where the buttons would be — the phone, the
// window passed, the computer gone quiet («상태 모름» chip, no waiting time), no paired phone. No button at all on the web.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { PermissionRequest } from '@/lib/agent-permissions';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
const { AgentPermissionRequests } = await import('./agent-permission-requests');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-03T14:00:00Z');
const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1', request_id: 'q1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: '개발',
  tool: 'Bash', summary: 'npm install --save ••••(가림) …', masked: true, truncated: true, workdir: '~/Sprintable/블로그 글',
  created_at: '2026-10-03T13:48:00Z', expires_at: '2026-10-03T14:30:00Z', state: 'pending', answered_by_name: null, decision: null,
  device_reachable: true, recipient_reason: 'paired', answerable: true, ...over,
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
      'npm install --save ••••(가림) …', '비밀처럼 보이는 값은 가려서 보냈어요 · 앞 200자만 보여요', '작업 폴더 · ~/Sprintable/블로그 글']) {
      expect(text()).toContain(piece);
    }
    expect(line()).toBe('짝지은 폰에서 답할 수 있어요');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('a quiet computer: «상태 모름» and no waiting time; a passed window and no paired phone say why it cannot be answered here', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ device_reachable: false })]));
    await render();
    expect(text()).toContain('상태 모름');
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
    expect(line()).toBe('그 컴퓨터와 짝지은 폰이 없어 여기서는 답할 수 없어요 — 그 컴퓨터의 터미널에서 답해 주세요');
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
    expect(line()).toBe('짝지은 폰에서 답할 수 있어요');
  });

  it('reads in English', async () => {
    fetchWithAuth.mockResolvedValueOnce(answer([req({ role: 'Developer' })]));
    await render('en');
    expect(text()).toContain('Agent permission requests · 1');
    expect(text()).toContain('Sent to the Developer role');
    expect(line()).toBe('You can answer from a paired phone');
  });
});
