// @vitest-environment jsdom
/** story #4761 (D3) — the line under my message to an agent nothing pushes to: the fact, the sentence (one tap), the app way. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AgentWakeNotice } from './agent-wake-notice';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('@/lib/clipboard', () => ({ copyTextSafely: vi.fn(async () => ({ ok: true })) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.clearAllMocks(); });

async function render(targets: { member_id: string; name: string }[], locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentWakeNotice targets={targets} />
      </NextIntlClientProvider>,
    );
  });
  return container.querySelector('[data-testid="agent-wake-notice"]');
}

describe('AgentWakeNotice (#4761)', () => {
  it('one agent — names it, gives the sentence, points at the app', async () => {
    const n = await render([{ member_id: 'a', name: 'Walk Agent' }]);
    expect(n?.textContent).toContain('이 에이전트(Walk Agent)는 새 메시지가 와도 스스로 알아채지 못해요');
    expect(n?.textContent).toContain('“새 메시지 확인하고 답해 줘”');
    expect(n?.textContent).toContain('메시지를 보낸 뒤 에이전트가 돌고 있는 터미널에 아래 문장을 입력해 주세요');
    expect(n?.textContent).toContain('Mac 앱을 쓰면 이 문장 없이도 새 메시지를 에이전트에게 넘겨요');
    expect(n?.querySelector('[data-testid="agent-wake-app-link"]')?.getAttribute('href')).toContain('/desktop');
    expect(n?.className).toMatch(/info/);
    expect(n?.className).not.toMatch(/red|destructive/); // nothing failed — the message is delivered
  });

  it('several agents — the first by name and a count of the rest', async () => {
    const n = await render([{ member_id: 'a', name: 'Alpha' }, { member_id: 'b', name: 'Beta' }, { member_id: 'c', name: 'Gamma' }]);
    expect(n?.textContent).toContain('에이전트 Alpha 외 2명은 새 메시지가 와도 스스로 알아채지 못해요');
  });

  it('the sentence copies in one tap and the button says so', async () => {
    const { copyTextSafely } = await import('@/lib/clipboard');
    await render([{ member_id: 'a', name: 'Walk Agent' }]);
    await act(async () => { (container.querySelector('[data-testid="agent-wake-copy"]') as HTMLElement).click(); });
    expect(copyTextSafely).toHaveBeenCalledWith('새 메시지 확인하고 답해 줘');
    expect(container.querySelector('[data-testid="agent-wake-copy"]')?.textContent).toContain('문장 복사됨');
  });

  it('nobody to wake → nothing is drawn', async () => {
    expect(await render([])).toBeNull();
  });

  it('en reads too', async () => {
    const n = await render([{ member_id: 'a', name: 'Walk Agent' }], 'en');
    expect(n?.textContent).toContain("This agent (Walk Agent) can't notice new messages on its own. After you send a message, type the sentence below in the terminal where the agent is running.");
    expect(n?.textContent).toContain('“Check for new messages and reply”');
  });
});
