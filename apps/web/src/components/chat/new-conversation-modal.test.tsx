// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import koMessages from '../../../messages/ko.json';
import { NewConversationModal } from './new-conversation-modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('NewConversationModal — agent message policy denial', () => {
  it('403 구조화 응답의 agent/member 이름을 사용해 허용 목록 조치를 안내한다', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        return new Response(JSON.stringify({
          data: [
            { id: 'human-1', name: '신이삭', type: 'human' },
            { id: 'agent-1', name: 'Ohol(COO)', type: 'agent' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: null,
        error: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: "Member is not in this agent's message allowlist",
          details: { agent_id: 'agent-1', member_id: 'human-1', reason: 'allowlist_miss' },
        },
        meta: null,
      }), { status: 403, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <NewConversationModal projectId="project-1" onClose={vi.fn()} onCreated={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      buttonByText('신이삭').click();
      buttonByText('Ohol(COO)Bot').click();
    });
    await act(async () => { buttonByText('대화 시작').click(); });
    await act(async () => { await Promise.resolve(); });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Ohol(COO)의 메시지 정책에서 신이삭님이 허용되지 않았습니다. 에이전트 소유자에게 허용 목록 추가를 요청해 주세요.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
