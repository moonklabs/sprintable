// @vitest-environment jsdom
//
// story #2613(PR #2824 승계) — POST /api/conversations/{id}/participants가
// AGENT_MESSAGE_POLICY_DENIED로 거부될 때도 new-conversation-modal.tsx와 동일한 actionable
// 안내가 뜨는지 잰다(공유 로직이라 배선만 다르고 결과는 동형이어야 한다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AddParticipantModal } from './add-participant-modal';
import koMessages from '../../../messages/ko.json';

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

const PROJECT_ID = 'proj-1';
const CONV_ID = 'conv-1';
const MEMBERS = [
  { id: 'm-yuna', name: '유나', type: 'human' },
  { id: 'a-bot', name: '점검봇', type: 'agent' },
];

function mockFetches(onPost: (body: unknown) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
    if (url === `/api/conversations/${CONV_ID}/participants` && init?.method === 'POST') {
      return onPost(JSON.parse(init.body!));
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function mountAndSelectBot(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(wrap(
      <AddParticipantModal
        conversationId={CONV_ID}
        conversationType="group"
        projectId={PROJECT_ID}
        existingParticipantIds={['m-yuna']}
        onClose={() => {}}
        onAdded={() => {}}
      />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const botBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('점검봇'))!;
  await act(async () => { botBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const addBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.chats.addParticipants) as HTMLButtonElement;
  await act(async () => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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

describe('AddParticipantModal — 에이전트 정책 거부 구조화 안내(story #2613)', () => {
  it('allowlist_miss — 대상 에이전트·멤버 이름과 워크포스 딥링크가 뜬다', async () => {
    await mountAndSelectBot(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        detail: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'member is not in the agent allowlist',
          details: { agent_id: 'a-bot', member_id: 'm-yuna', reason: 'allowlist_miss' },
        },
      }),
    })));

    expect(document.body.textContent).toContain('유나');
    expect(document.body.textContent).toContain('점검봇');
    expect(document.body.textContent).not.toContain('member is not in the agent allowlist');
    const link = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/workforce/a-bot');
    expect(link).toBeDefined();
  });

  it('정책 거부가 아닌 실패는 기존 generic 문구 그대로(회귀 0)', async () => {
    await mountAndSelectBot(mockFetches(() => ({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) })));
    expect(document.body.textContent).toContain('참여자 추가에 실패했습니다. 다시 시도해보세요.');
    expect(document.body.querySelectorAll('a[href^="/organization/workforce/"]').length).toBe(0);
  });
});

// story #3000 로드맵 PR-B(L5) — 후보 목록의 Bot 배지 배경은 정적 정체성 마킹이라 citron이
// 아니라 proof-blue-soft여야 한다.
describe('AddParticipantModal — 로드맵 PR-B L5(Bot 배지 배경 proof-blue-soft)', () => {
  it('agent 후보 항목의 Bot 배지가 bg-proof-blue-soft를 쓰고 bg-accent-claim은 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(wrap(
        <AddParticipantModal
          conversationId={CONV_ID} conversationType="group" projectId={PROJECT_ID}
          existingParticipantIds={['m-yuna']} onClose={() => {}} onAdded={() => {}}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const badge = document.body.querySelector('.rounded-sm.bg-proof-blue-soft');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('Bot');
    expect(document.body.querySelector('.bg-accent-claim\\/15')).toBeNull();
  });
});
