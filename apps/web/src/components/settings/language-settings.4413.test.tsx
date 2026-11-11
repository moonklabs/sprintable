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
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light', systemTheme: 'light' }) }));

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

// story 4891 (piece ③): the row is a ds NativeSelect now (the phone's own picker) — choosing = a change event on the select
const select = () => container.querySelector('select') as HTMLSelectElement;
async function choose(value: string) {
  await act(async () => { select().value = value; select().dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('설정 언어 행(story #4413)', () => {
  it.each(['ko', 'en'] as const)('⭐UI가 %s여도 선택지는 늘 «한국어 · English»(자기 언어 이름) · 지금 언어가 골라져 있다', async (locale) => {
    await mount(locale);
    expect(select().value).toBe(locale);
    expect([...select().options].map((o) => o.textContent?.trim())).toEqual(['한국어', 'English']);
    // the name is a real <label for> (not a bare text) — the picker is named for a screen reader
    expect(container.querySelector(`label[for="${select().id}"]`)?.textContent).toBe((locale === 'ko' ? koMessages : enMessages).settings.languageSelectLabel);
  });

  it('⭐다른 언어를 고르면 사이드바 전환기와 같은 applyLocale을 부른다 · 지금 언어를 다시 고르면 안 부른다', async () => {
    await mount('ko');
    await choose('en');
    expect(applyLocaleSpy).toHaveBeenCalledWith('en');
    applyLocaleSpy.mockReset();
    await choose('ko');
    expect(applyLocaleSpy).not.toHaveBeenCalled();
  });
});

describe('설정 언어 행 — 반대 방향 · 지역 표기(story 4891 ③)', () => {
  it('English UI → «한국어»를 고르면 applyLocale(ko) (고정된 en이 아니다), 같은 English를 다시 고르면 안 부른다', async () => {
    await mount('en');
    await choose('ko');
    expect(applyLocaleSpy).toHaveBeenCalledWith('ko');
    applyLocaleSpy.mockReset();
    await choose('en');
    expect(applyLocaleSpy).not.toHaveBeenCalled();
  });

  it.each([['en-US', 'en'], ['ko-KR', 'ko']] as const)('locale %s → 선택 상자는 %s로 보인다(지역 표기를 접는다)', async (locale, shown) => {
    const { LanguageSettings } = await import('./language-settings');
    await act(async () => {
      root.render(<NextIntlClientProvider locale={locale} messages={shown === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><LanguageSettings /></NextIntlClientProvider>);
    });
    expect(select().value).toBe(shown);
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

describe('사이드바 테마 토글 묶음 이름(story #4413)', () => {
  it('탭 이름이 «화면»으로 바뀌어도 토글 묶음 aria-label은 «테마» 그대로(tabAppearance 키)', async () => {
    const { ThemeToggle } = await import('@/components/nav/theme-toggle');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ThemeToggle /></NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('테마');
  });
});
