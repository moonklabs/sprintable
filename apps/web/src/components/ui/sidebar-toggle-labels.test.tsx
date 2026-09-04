// @vitest-environment jsdom
//
// story 3436(묶음 1) — 전역 셸 접근 이름 하드코딩 영문 정정. SidebarTrigger(sr-only)·
// SidebarRail(aria-label·title) 둘 다 기본값(override 없음)이 한국어로 뜨는지 pin —
// dialog.tsx·sheet.tsx의 「Close」와 같은 클래스 결함, 같은 PR.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { SidebarProvider, SidebarTrigger, SidebarRail } from './sidebar';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(locale: 'ko' | 'en', node: React.ReactNode) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      <SidebarProvider>{node}</SidebarProvider>
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('SidebarTrigger — sr-only 접근 이름(story 3436)', () => {
  it('⭐ko 로케일에서 sr-only 텍스트가 한국어다(하드코딩 "Close"류 결함과 같은 클래스)', async () => {
    await act(async () => { root.render(wrap('ko', <SidebarTrigger />)); });
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(koMessages.nav.toggleSidebar);
    expect(srOnly?.textContent).not.toContain('Toggle Sidebar');
  });

  it('en 로케일에서는 영문 그대로다(회귀 0 — en 사용자는 원래도 맞았다)', async () => {
    await act(async () => { root.render(wrap('en', <SidebarTrigger />)); });
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(enMessages.nav.toggleSidebar);
  });
});

describe('SidebarRail — aria-label·title(story 3436)', () => {
  it('⭐ko 로케일에서 aria-label·title이 한국어다', async () => {
    await act(async () => { root.render(wrap('ko', <SidebarRail />)); });
    const rail = container.querySelector('[data-slot="sidebar-rail"]');
    expect(rail?.getAttribute('aria-label')).toBe(koMessages.nav.toggleSidebar);
    expect(rail?.getAttribute('title')).toBe(koMessages.nav.toggleSidebar);
  });
});
