// @vitest-environment jsdom
//
// story #2865 — ProfileMenu 드롭다운에 「약관 및 정책」 그룹(3링크)이 상시 접근 경로로
// 추가됐다. 배선이 아니라 «표시를 테스트»한다: 드롭다운을 열었을 때 3개 링크가 실제로
// 렌더되고 기존 legal 라우트로 걸리는지 화면 결과로 확인한다.

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

describe('ProfileMenu — 약관 및 정책 드롭다운 그룹 (story #2865)', () => {
  it('드롭다운을 열면 약관 및 정책 3링크가 렌더되고 기존 legal 라우트로 걸린다', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();

    // base-ui Menu.Portal은 document.body에 렌더된다(컨테이너 내부가 아님).
    const anchors = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"] a'));
    const hrefs = anchors.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/privacy');
    expect(hrefs).toContain('/refund-policy');

    const labels = anchors.map((a) => a.textContent);
    expect(labels).toContain('이용약관');
    expect(labels).toContain('개인정보처리방침');
    expect(labels).toContain('환불정책');
  });

  it('약관 및 정책 그룹이 설정↔로그아웃 사이에 위치한다', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();

    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content).toBeTruthy();
    const items = Array.from(content!.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent ?? '',
    );
    const settingsIdx = items.findIndex((t) => t.includes('설정'));
    const termsIdx = items.findIndex((t) => t.includes('이용약관'));
    const signOutIdx = items.findIndex((t) => t.includes('로그아웃'));
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(termsIdx).toBeGreaterThan(settingsIdx);
    expect(signOutIdx).toBeGreaterThan(termsIdx);
  });

  it('raw i18n 키가 노출되지 않는다', async () => {
    await mount(<ProfileMenu name="송윤재" />);
    await openMenu();
    const text = document.querySelector('[data-slot="dropdown-menu-content"]')?.textContent ?? '';
    expect(text).not.toMatch(/policiesHeading|termsOfService|privacyPolicy|refundPolicy/);
  });
});
