// @vitest-environment jsdom
//
// story #3972(E-UX-OVERHAUL·「대화」 구현 2/N) — AC6 첫 화면 ≤3콜(대화목록·메시지·
// 오늘 스냅샷 역조회는 관련 절에서만·열린 산출물은 references 있을 때만) + 렌더
// 통합(스레드 선택→메시지 렌더→역할 태그).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const ME = { data: { id: 'me-1', project_id: 'proj-1', role: 'member' } };
const THREADS = {
  data: [
    {
      id: 'conv-1',
      participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-1', name: '담롱 온찬', type: 'agent' }],
      latest_message: { content: '발행 승인을 올려요', created_at: '2026-09-16T06:41:00Z' },
      unread_count: 1,
    },
  ],
};
const MESSAGES = {
  data: [
    {
      id: 'm1', created_by: 'agent-1', sender_name: '담롱 온찬', sender_type: 'agent', sender_avatar_url: null,
      sender_runtime_type: null, content: '초안을 마쳤어요.', attachments: [], created_at: '2026-09-16T06:41:00Z',
      references: [], approval_target: null,
    },
  ],
};
const EMPTY_TODAY = { data: { needs_me: [], needs_me_count: 0, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } } } };

function stub() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
    if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => THREADS };
    if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => MESSAGES };
    if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { ChatV3Screen } = await import('./chat-v3-screen');
  await act(async () => { root.render(wrap(<ChatV3Screen />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ChatV3Screen — 첫 화면 렌더', () => {
  it('⭐스레드 목록·역할 태그(에이전트)·자동 선택된 스레드의 메시지가 렌더된다', async () => {
    stub();
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-thread-row"]')?.textContent).toContain('담롱 온찬');
    expect(container.textContent).toContain('에이전트');
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('초안을 마쳤어요');
  });

  it('⭐안읽음 점 — unread_count>0이면 렌더된다', async () => {
    stub();
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-unread-dot"]')).not.toBeNull();
  });

  it('⭐대화 목록 콜은 project_id+include_agent_conversations을 싣는다', async () => {
    stub();
    await mount();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/conversations?'));
    expect(call?.[0]).toContain('project_id=proj-1');
    expect(call?.[0]).toContain('include_agent_conversations=true');
  });
});
