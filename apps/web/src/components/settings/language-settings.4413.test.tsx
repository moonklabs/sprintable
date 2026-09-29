// @vitest-environment jsdom
//
// story #4413 — 폰에서 언어를 바꿀 자리(설정 «화면» 탭 · 테마 아래). 선택지는 지금 언어와 무관하게 늘 자기 언어 이름(한국어 · English)이고,
// 고르면 사이드바 전환기와 같은 동작(locale 쿠키 + 새로고침)을 탄다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { applyLocaleSpy } = vi.hoisted(() => ({ applyLocaleSpy: vi.fn() }));
vi.mock('@/components/locale-switcher', async (orig) => ({ ...(await orig<object>()), applyLocale: applyLocaleSpy }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  applyLocaleSpy.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(locale: 'ko' | 'en') {
  const { LanguageSettings } = await import('./language-settings');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <LanguageSettings />
      </NextIntlClientProvider>,
    );
  });
}

async function openMenu() {
  const trigger = container.querySelector('button') as HTMLButtonElement;
  await act(async () => { trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); trigger.click(); });
  await act(async () => { await Promise.resolve(); });
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}

describe('설정 언어 행(story #4413)', () => {
  it.each(['ko', 'en'] as const)('⭐UI가 %s여도 선택지는 늘 «한국어 · English»(자기 언어 이름) · 지금 언어가 보인다', async (locale) => {
    await mount(locale);
    expect(container.querySelector('button')!.textContent).toContain(locale === 'ko' ? '한국어' : 'English');
    const items = await openMenu();
    expect(items.map((i) => i.textContent?.trim())).toEqual(['한국어', 'English']);
  });

  it('⭐다른 언어를 고르면 사이드바 전환기와 같은 applyLocale을 부른다 · 지금 언어를 다시 고르면 안 부른다', async () => {
    await mount('ko');
    let items = await openMenu();
    await act(async () => { items[1]!.click(); });
    expect(applyLocaleSpy).toHaveBeenCalledWith('en');
    applyLocaleSpy.mockReset();
    items = await openMenu();
    await act(async () => { items[0]!.click(); });
    expect(applyLocaleSpy).not.toHaveBeenCalled();
  });
});

describe('applyLocale(story #4413 · 사이드바 전환기와 한 원천)', () => {
  it('locale 쿠키(1년)를 쓰고 새로고침한다', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, reload }, configurable: true, writable: true });
    try {
      const { applyLocale } = await vi.importActual<typeof import('@/components/locale-switcher')>('@/components/locale-switcher');
      applyLocale('en');
      expect(document.cookie).toContain('locale=en');
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true, writable: true });
    }
  });
});
