// @vitest-environment jsdom
//
// story #2870 — GNB의 법적 고지 접점이 단일화됐다(사이드바 footer 「사업자 정보」 토글로
// 수렴). ProfileMenu의 「약관 및 정책」 그룹(story #2865에서 추가)은 중복이라 제거됐다 —
// 이 스위트는 그 회귀를 막는다: 배선이 아니라 «표시 부재»를 테스트한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProfileMenu } from './profile-menu';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ data: { accounts: [] } }) })),
  );
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.querySelectorAll('[data-slot="dropdown-menu-content"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
}

async function openMenu() {
  const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  expect(trigger).toBeTruthy();
  await act(async () => { trigger.click(); });
}

describe('ProfileMenu — 약관 및 정책 그룹 제거 회귀가드 (story #2870)', () => {
  it('드롭다운에 법적 문서 링크가 0건이다(GNB footer 토글로 수렴)', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();

    const anchors = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"] a'));
    const hrefs = anchors.map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/terms');
    expect(hrefs).not.toContain('/privacy');
    expect(hrefs).not.toContain('/refund-policy');
  });

  it('설정 항목 바로 다음이 로그아웃이다(약관 그룹 자리가 완전히 비었다)', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();

    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content).toBeTruthy();
    const items = Array.from(content!.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent ?? '',
    );
    const settingsIdx = items.findIndex((t) => t.includes('설정'));
    const signOutIdx = items.findIndex((t) => t.includes('로그아웃'));
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(signOutIdx).toBe(settingsIdx + 1);
  });
});

// story #3146/#3147(모바일 스위처 통합 재설계, doc mobile-switcher-redesign-spec-4758744a)
// — 계정 스위치 로직을 useAccountSwitcher 훅으로 추출(profile-menu.tsx 원 동작 재구현
// 0)+데스크톱 트리거를 밝은 배경(context-switcher-chip.tsx 계정층)에도 재사용 가능하게
// triggerClassName 오버라이드 신설.
describe('ProfileMenu — story #3146/#3147 훅 추출 후 무회귀 + triggerClassName 오버라이드', () => {
  it('triggerClassName 생략 시 기존 sidebar 테마 트리거 그대로(회귀 0)', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
    expect(trigger.className).toContain('hover:bg-sidebar-accent');
    const nameSpan = trigger.querySelector('span.truncate');
    expect(nameSpan?.className).toContain('text-sidebar-foreground');
  });

  it('triggerClassName 전달 시 그 클래스로 완전히 갈아끼워진다(밝은 배경용)', async () => {
    await mount(<ProfileMenu name="송윤재" triggerClassName="min-h-12 rounded-xl bg-red-500" />);
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
    expect(trigger.className).toBe('min-h-12 rounded-xl bg-red-500');
    const nameSpan = trigger.querySelector('span.truncate');
    expect(nameSpan?.className).toContain('text-foreground');
    expect(nameSpan?.className).not.toContain('sidebar');
  });

  it('훅 추출 후에도 계정 전환 클릭이 여전히 /api/auth/switch-account를 호출한다(로직 회귀 0)', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/api/accounts') {
        return { ok: true, json: async () => ({ data: { accounts: [
          { account_id: 'a1', name: '송윤재', email: null, org_name: null, avatar_url: null, status: 'active' },
          { account_id: 'a2', name: '부계정', email: null, org_name: null, avatar_url: null, status: 'inactive' },
        ] } }) };
      }
      if (url === '/api/auth/switch-account') {
        return { ok: true, json: async () => ({ data: { ok: true } }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('location', { assign: vi.fn() } as unknown as Location);

    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();
    const items = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"] [role="menuitem"]'));
    const otherAccountItem = items.find((el) => el.textContent?.includes('부계정'));
    expect(otherAccountItem).toBeTruthy();
    await act(async () => { (otherAccountItem as HTMLElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/switch-account', expect.objectContaining({ method: 'POST' }));
  });
});
