// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { AuUsageBanner } from './au-usage-banner';

const useDashboardContextMock = vi.fn();
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function statusResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderBanner() {
  return act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AuUsageBanner />
      </NextIntlClientProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1' });
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('AuUsageBanner — role gate(story #3190, PO 지시: 관리자 한정)', () => {
  it('can_manage=false면 80% 초과여도 렌더하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 90, au_limit: 100, au_paused: false, can_manage: false })));
    await renderBanner();
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('AuUsageBanner — 임계값별 렌더', () => {
  it('80% 미만이면 렌더하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 50, au_limit: 100, au_paused: false, can_manage: true })));
    await renderBanner();
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('paused=true면 destructive·dismiss 버튼 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 120, au_limit: 100, au_paused: true, can_manage: true })));
    await renderBanner();
    await flush();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.querySelector('svg.text-destructive')).not.toBeNull();
    expect(container.querySelector('button[aria-label="이번 세션 동안 숨기기"]')).toBeNull();
  });
});

// PO 집행세칙①(2026-08-28) — 80%에서 dismiss한 뒤 90%로 승급하면 재등장해야 한다.
describe('AuUsageBanner — dismiss 밴드 승급 재무장(story #3190 PO 집행세칙①)', () => {
  it('80%에서 dismiss → 세션 내 재마운트해도 여전히 80%면 숨는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 82, au_limit: 100, au_paused: false, can_manage: true })));
    await renderBanner();
    await flush();
    const dismissBtn = container.querySelector('button[aria-label="이번 세션 동안 숨기기"]') as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();
    await act(async () => {
      dismissBtn.click();
    });
    expect(sessionStorage.getItem('au-usage-warn-dismissed-band')).toBe('80');

    // 새 마운트(레이아웃 재로드 시나리오) — 여전히 80%대.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderBanner();
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('80%에서 dismiss 후 90%로 승급하면 재등장한다', async () => {
    sessionStorage.setItem('au-usage-warn-dismissed-band', '80');
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 95, au_limit: 100, au_paused: false, can_manage: true })));
    await renderBanner();
    await flush();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('90');
  });

  it('80%에서 dismiss 후 해소(<80%)됐다가 재크로싱하면 재등장한다', async () => {
    sessionStorage.setItem('au-usage-warn-dismissed-band', '80');
    // 1차: 해소됨(<80%) — 저장된 dismiss가 재무장(clear)돼야 한다.
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 10, au_limit: 100, au_paused: false, can_manage: true })));
    await renderBanner();
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(sessionStorage.getItem('au-usage-warn-dismissed-band')).toBeNull();

    // 2차: 재크로싱(다시 80%대) — 이전 dismiss가 지워졌으니 다시 보여야 한다.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse({ au_current: 81, au_limit: 100, au_paused: false, can_manage: true })));
    await renderBanner();
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
