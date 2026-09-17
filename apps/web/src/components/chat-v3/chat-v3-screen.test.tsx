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

function meFixture(role: 'owner' | 'admin' | 'member') {
  return { data: { id: 'me-1', project_id: 'proj-1', role } };
}
const ME = meFixture('owner');
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

function stub(meOverride: unknown = ME) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { ok: true, status: 200, json: async () => meOverride };
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

  it('⭐대화 목록 콜 — owner면 project_id+include_agent_conversations을 싣는다', async () => {
    stub(meFixture('owner'));
    await mount();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/conversations?'));
    expect(call?.[0]).toContain('project_id=proj-1');
    expect(call?.[0]).toContain('include_agent_conversations=true');
  });

  // 페드루 PO CHANGES C1(2026-09-17 00:04Z, PR #4370) — include_agent_conversations은
  // owner/admin 전용(conversations.py:1462-1467) — member가 보내면 BE가 403 거부해
  // 화면 전체가 죽는다. member는 그 파라미터를 아예 안 보내야 한다.
  it('⭐대화 목록 콜 — member면 include_agent_conversations을 안 싣는다(403 회피)', async () => {
    stub(meFixture('member'));
    await mount();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/conversations?'));
    expect(call?.[0]).toContain('project_id=proj-1');
    expect(call?.[0]).not.toContain('include_agent_conversations');
  });

  // 페드루 PO CHANGES C2 — /api/me 실패를 조용히 삼키면 화면이 무한 로딩으로 보인다.
  it('⭐/api/me 실패 — 무한 로딩 대신 오류 상태', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-loading"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('불러오지 못했어요');
  });
});
