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
