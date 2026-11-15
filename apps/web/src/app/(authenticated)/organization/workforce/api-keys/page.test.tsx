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

// story 4912 (B1) — the screen sets the top bar title; the top bar itself is not under test here
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));

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
    expect(container.querySelectorAll('[data-testid^="api-key-row-"]').length).toBe(1); // story 4912 (B1): one ROW per agent (the card opens in a panel)
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
    // story 4912 (B1): the rows carry the labels; the manager (in the panel) gets the label for its head and the ORIGINAL name for the message to the agent
    const rows = [...container.querySelectorAll('[data-testid^="api-key-row-"]')];
    expect(rows.map((r) => r.querySelector('[data-slot="ds-list-row"] .font-semibold')?.textContent)).toEqual(['봇 · aaaa1111', '봇 · bbbb2222', koMessages.common.agentUnnamed]);
    const open = async (i: number) => { await act(async () => { (rows[i]!.querySelector('button:not([data-slot="ds-row-actions-trigger"])') as HTMLElement).click(); }); await act(async () => { await Promise.resolve(); }); };
    await open(0);
    let card = document.querySelector('[data-testid="stub-agent-api-key-manager"]')!;
    expect(card.getAttribute('data-agent-label')).toBe('봇 · aaaa1111');
    expect(card.textContent).toBe('봇');
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await open(2);
    card = document.querySelector('[data-testid="stub-agent-api-key-manager"]')!;
    expect(card.getAttribute('data-agent-label')).toBe(koMessages.common.agentUnnamed);
    expect(card.textContent).toBe('');
  });
});

// story 4889 — the big title sat against the shell column's left edge; story 4912 (B1): the screen is now ONE of the three frame widths (the frame owns the margins — no hand-written container)
describe('ApiKeysPage — 쪽 틀(story 4912)', () => {
  it('⭐본문은 PageFrame reading 안에 선다(손으로 쓴 container · px-4 없음) — 큰 «에이전트 API 키» 제목은 위 막대로', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await mount();
    expect(container.querySelector('[data-slot="ds-page-frame"]')?.getAttribute('data-width')).toBe('reading');
    expect(container.querySelector('div.container')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
  });
});
