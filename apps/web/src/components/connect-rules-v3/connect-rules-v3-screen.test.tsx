// @vitest-environment jsdom
//
// story #3982 — 셸(nav·topbar)·org_id 해소 3상태(로딩·오류·성공)만 이 파일에서 고정,
// 섹션별 상세는 각 섹션 자체 테스트가 담당(중복 재검증 0).
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
  vi.resetModules();
});

async function mount(props?: { todayV3Enabled?: boolean; chatV3Enabled?: boolean }) {
  const { ConnectRulesV3Screen } = await import('./connect-rules-v3-screen');
  await act(async () => { root.render(wrap(<ConnectRulesV3Screen {...props} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ConnectRulesV3Screen', () => {
  it('제목·nav 5개·검색창이 렌더된다', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await mount();
    expect(container.querySelector('h1')?.textContent).toBe('연결·규칙');
    expect(container.querySelectorAll('[data-testid^="connect-rules-v3-nav-"]').length).toBe(5);
    expect(container.querySelector('[data-testid="connect-rules-v3-nav-navConnectRules"]')?.className).toContain('text-primary');
  });

  it('⭐/api/me 실패 — 보이는 「다시 시도」 버튼', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
    expect(container.querySelector('button')?.textContent).toContain('다시 시도');
  });

  it('org_id 해소 성공 — 세 섹션 제목이 모두 렌더된다', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: true, status: 200, json: async () => ({ data: { org_id: 'org1', role: 'owner' } }) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    await mount();
    expect(container.textContent).toContain('연결된 에이전트');
    expect(container.textContent).toContain('연결된 채널');
    expect(container.textContent).toContain('콘텐츠 규칙');
  });

  it('⭐교차 링크 — 오늘·대화 v3 플래그 off(기본)면 기존 라이브 경로로, on이면 v3 경로로', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await mount();
    expect(container.querySelector('[data-testid="connect-rules-v3-nav-navToday"]')?.getAttribute('href')).toBe('/org-briefing');
    expect(container.querySelector('[data-testid="connect-rules-v3-nav-navChats"]')?.getAttribute('href')).toBe('/chats');
  });

  it('교차 링크 — 오늘·대화 v3 플래그 on이면 새 v3 경로로 바뀐다', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
    await mount({ todayV3Enabled: true, chatV3Enabled: true });
    expect(container.querySelector('[data-testid="connect-rules-v3-nav-navToday"]')?.getAttribute('href')).toBe('/today');
    expect(container.querySelector('[data-testid="connect-rules-v3-nav-navChats"]')?.getAttribute('href')).toBe('/chat');
  });
});
