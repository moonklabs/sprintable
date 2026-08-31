// @vitest-environment jsdom
//
// story #3231 4라운드(카디르 QA) — 이 컴포넌트는 부모(workforce/[id]/page.tsx)의
// canEdit(생성자 OR org admin/owner — BE assert_agent_owner와 정합)로 이미 올바르게
// 게이트돼 있었다. 그런데 내부의 allowlist 후보 fetch가 org-admin 전용 org-members
// roster를 썼던 게 회귀 원인 — Member가 만든 에이전트는 그 생성자 본인도 403이라
// allowlist 후보를 못 봤다. assert_agent_owner와 동일 게이트의 agent 전용 후보
// 엔드포인트로 교체됐는지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MessagingPolicySection } from './messaging-policy-section';
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('MessagingPolicySection — allowlist 후보를 agent 전용 엔드포인트에서 받는다(story #3231 4라운드)', () => {
  it('원 org-members roster가 아니라 /api/agents/{id}/message-policy/candidates를 호출한다', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/agents/agent-1/message-policy') {
        return { ok: true, json: async () => ({ data: { mode: 'creator_only', allowlist: [] } }) };
      }
      if (url === '/api/agents/agent-1/message-policy/candidates') {
        return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-1', name: '멤버 하나' }] }) };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush();

    expect(calls).not.toContain('/api/org-members');
    expect(calls).toContain('/api/agents/agent-1/message-policy/candidates');
  });

  it('candidates가 403이어도(Member 생성자, 방어적 케이스) 크래시 없이 빈 목록으로 저하된다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/agents/agent-1/message-policy') {
        return { ok: true, json: async () => ({ data: { mode: 'creator_only', allowlist: [] } }) };
      }
      if (url === '/api/agents/agent-1/message-policy/candidates') {
        return { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush();

    // 크래시 없이 마운트 완료 — 섹션 헤더 텍스트가 실제로 뜬 것으로 확인.
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});
