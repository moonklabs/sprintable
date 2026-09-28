// @vitest-environment jsdom
//
// story #3994(«거짓 경고» 클래스, PO 확定) — 「시스템 발행」에 API 키를 발급하는 것
// 자체가 의미 없다(연결 대상이 아닌 내부 멤버) — 이 관리 목록에서 제외.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import ApiKeysPage from './page';

vi.mock('@/components/agents/agent-api-key-manager', () => ({
  AgentApiKeyManager: ({ agentId, agentName, agentLabel }: { agentId: string; agentName: string; agentLabel?: string }) => (
    <div data-testid="stub-agent-api-key-manager" data-agent-id={agentId} data-agent-label={agentLabel ?? ''}>{agentName}</div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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

async function mount() {
  // [SID:4311 PR 3] 페이지가 목록 라벨(«이름 없는 에이전트» 등)에 common 문구를 쓴다.
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ApiKeysPage /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ApiKeysPage — 시스템 발행 제외(story #3994)', () => {
  it('⭐「시스템 발행」은 키 관리 목록에 안 뜨고, 실 에이전트만 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members?')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'sp1', name: '시스템 발행', type: 'agent', is_active: true, runtime_type: 'system-publisher' },
              { id: 'a1', name: '실 에이전트', type: 'agent', is_active: true, runtime_type: 'claude-code' },
            ],
          }),
        };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();
    expect(container.textContent).not.toContain('시스템 발행');
    expect(container.textContent).toContain('실 에이전트');
    expect(container.querySelectorAll('[data-testid="stub-agent-api-key-manager"]').length).toBe(1);
  });
});

// [SID:4311 PR 3] 에이전트 칸 머리 — 같은 이름 둘이면 «· ID 앞 8자» · 이름 빔 = «이름 없는 에이전트» · 에이전트에게 보내는 이름(agentName)은 원래 이름.
describe('ApiKeysPage — 에이전트 동명이인([SID:4311 PR 3])', () => {
  it('«봇» 둘 = 머리 라벨에 id 앞 8자 · 이름 빔 = «이름 없는 에이전트» · agentName은 원래 이름', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members?')) {
        return { ok: true, json: async () => ({ data: [
          { id: 'aaaa1111-1', name: '봇', type: 'agent', is_active: true, runtime_type: 'claude-code' },
          { id: 'bbbb2222-2', name: '봇', type: 'agent', is_active: true, runtime_type: 'claude-code' },
          { id: 'cccc3333-3', name: null, type: 'agent', is_active: true, runtime_type: 'claude-code' },
        ] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();
    const cards = [...container.querySelectorAll('[data-testid="stub-agent-api-key-manager"]')];
    expect(cards.map((c) => c.getAttribute('data-agent-label'))).toEqual(['봇 · aaaa1111', '봇 · bbbb2222', koMessages.common.agentUnnamed]);
    expect(cards.map((c) => c.textContent)).toEqual(['봇', '봇', '']);
  });
});

