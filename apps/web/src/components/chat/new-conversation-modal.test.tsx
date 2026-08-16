// @vitest-environment jsdom
//
// story #2613(PR #2824 승계) — POST /api/conversations가 AGENT_MESSAGE_POLICY_DENIED
// 구조화 403으로 거부될 때 모달이 대상 에이전트·멤버·조치 안내(워크포스 딥링크)를 표시하는지
// 잰다(AC2). 그 외 실패(기존 generic 문구)는 회귀 없이 그대로인지도 함께 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
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
const MEMBERS = [
  { id: 'm-yuna', name: '유나', type: 'human' },
  { id: 'a-bot', name: '점검봇', type: 'agent' },
];

function mockFetches(onPost: (body: unknown) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
    if (url === '/api/conversations' && init?.method === 'POST') {
      return onPost(JSON.parse(init.body!));
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function mountAndSelect(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(wrap(<NewConversationModal projectId={PROJECT_ID} onClose={() => {}} onCreated={() => {}} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const botBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('점검봇'))!;
  await act(async () => { botBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const createBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.chats.create) as HTMLButtonElement;
  await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
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

describe('NewConversationModal — 에이전트 정책 거부 구조화 안내(story #2613)', () => {
  it('allowlist_miss — 대상 에이전트·멤버 이름과 워크포스 딥링크가 뜬다(AC2)', async () => {
    await mountAndSelect(mockFetches(() => ({
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
    // 서버의 영문 고정 메시지는 그대로 노출되지 않는다(계약 원칙).
    expect(document.body.textContent).not.toContain('member is not in the agent allowlist');
    const link = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/workforce/a-bot');
    expect(link).toBeDefined();
    expect(link!.textContent).toBe(koMessages.chats.policyDeniedManageLink);
  });

  it('created_by_none — member_id 없어도 에이전트 이름과 딥링크가 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        detail: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'agent has no creator',
          details: { agent_id: 'a-bot', reason: 'created_by_none' },
        },
      }),
    })));

    expect(document.body.textContent).toContain('점검봇');
    expect(document.body.textContent).toContain(koMessages.chats.policyDeniedCreatedByNone.replace('{agent}', '점검봇'));
    const link = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/workforce/a-bot');
    expect(link).toBeDefined();
  });

  it('creator_not_participant — 에이전트 이름과 딥링크가 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        detail: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'creator not a participant',
          details: { agent_id: 'a-bot', reason: 'creator_not_participant' },
        },
      }),
    })));

    expect(document.body.textContent).toContain(koMessages.chats.policyDeniedCreatorNotParticipant.replace('{agent}', '점검봇'));
  });

  it('정책 거부가 아닌 4xx(generic)는 기존 문구 그대로(회귀 0) — 딥링크는 안 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({ ok: false, status: 422, json: async () => ({ detail: 'unrelated validation error' }) })));

    expect(document.body.textContent).toContain('대화 생성에 실패했습니다. 다시 시도해보세요.');
    expect(document.body.querySelectorAll('a[href^="/organization/workforce/"]').length).toBe(0);
  });

  it('res.json()이 파싱 자체를 실패해도(빈 바디 등) generic 문구로 안전 폴백한다', async () => {
    await mountAndSelect(mockFetches(() => ({ ok: false, status: 500, json: async () => { throw new Error('no body'); } })));
    expect(document.body.textContent).toContain('대화 생성에 실패했습니다. 다시 시도해보세요.');
  });
});
