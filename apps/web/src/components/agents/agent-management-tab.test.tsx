// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — meRes/projectsRes 둘 다 부수(ok?채움:방치,
// meRes는 isAdmin 판정만)인데 격리 없이 같은 try 안에 있어, meRes가 네트워크단 reject하면
// 바깥 catch가 setLoadError(true)로 승격시켜 에이전트 목록(이 탭의 실제 주 콘텐츠)까지
// 통째로 못 뜨던 결함의 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentManagementTab } from './agent-management-tab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
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

function stubFetch(opts: { meReject?: boolean; agents?: { id: string; name: string; role: string; is_active: boolean }[] } = {}) {
  const agents = opts.agents ?? [{ id: 'a1', name: '에이전트 하나', role: 'member', is_active: true }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url === '/api/me') {
      if (opts.meReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
    }
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/team-members?')) {
      return { ok: true, json: async () => ({ data: agents }) };
    }
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<AgentManagementTab />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('AgentManagementTab — meRes/projectsRes 격리(story #3519)', () => {
  it('/api/me가 네트워크 reject해도 에이전트 목록(주 콘텐츠)은 그대로 뜬다(loadError로 승격 안 됨)', async () => {
    stubFetch({ meReject: true });
    await mount();
    expect(container.textContent).toContain('에이전트 하나');
  });
});

// story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「비활성화」 접근 이름이라 보조기술
// 버튼 목록에서 어느 에이전트 행인지 못 가른다.
describe('AgentManagementTab — 토글 버튼 접근 이름 전수(story #3592)', () => {
  it('⭐#3592 — 2건이면 두 「비활성화」 버튼의 접근 이름이 서로 다르고 각자 순번을 품는다', async () => {
    stubFetch({
      agents: [
        { id: 'a1', name: '에이전트 하나', role: 'member', is_active: true },
        { id: 'a2', name: '에이전트 둘', role: 'member', is_active: true },
      ],
    });
    await mount();

    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === '비활성화');
    expect(buttons).toHaveLength(2);
    const names = buttons.map((b) => b.getAttribute('aria-label'));
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain('1번째');
    expect(names[0]).toContain('비활성화');
    expect(names[1]).toContain('2번째');
    expect(names[1]).toContain('비활성화');
  });
});

// story #3608(유나 §22-18 ④-2, PO 確定 2026-09-07) — pending 中 "..."는 위 aria-label
// 안에도 그대로 들어갔다(발견 시점 실측). 활성화는 확認 다이얼로그 없이 즉시 실행되므로
// (requestToggle의 확認-우회 분기, story #2406 AC1) 그 경로로 pending 상태를 잡는다.
describe('AgentManagementTab — pending 라벨 낱말화(story #3608)', () => {
  it('⭐#3608 — 활성화 pending 中 접근 이름·보이는 글자에 "..." 0, "변경 중" 포함', async () => {
    let resolvePatch!: () => void;
    const patchPending = new Promise<void>((resolve) => { resolvePatch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url !== 'string') return { ok: false, json: async () => null };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { role: 'admin' } }) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      if (url.startsWith('/api/team-members?')) {
        return { ok: true, json: async () => ({ data: [{ id: 'a1', name: '에이전트 하나', role: 'member', is_active: false }] }) };
      }
      if (url === '/api/team-members/a1' && init?.method === 'PATCH') {
        await patchPending;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();

    const toggleBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '활성화');
    expect(toggleBtn).not.toBeUndefined();
    await act(async () => {
      toggleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(toggleBtn!.textContent).not.toContain('...');
    expect(toggleBtn!.textContent).toContain('변경 중');
    const ariaLabel = toggleBtn!.getAttribute('aria-label');
    expect(ariaLabel).not.toContain('...');
    expect(ariaLabel).toContain('변경 중');
    resolvePatch();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  });
});
