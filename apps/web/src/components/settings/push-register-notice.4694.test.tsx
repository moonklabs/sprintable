// @vitest-environment jsdom
//
// [SID:4694 AC2 ②] 폰 설정 › 알림: «이 폰을 알림 받을 기기로 등록하지 못했어요» 한 줄 + [다시 시도]. 문구 정본 = yuna/4694-ac2-push-register-copy-1019.md.
// 폰 앱 안에서만 · 등록이 멀쩡하면 아무것도 안 그림 · 원인 둘(권한 꺼짐 / 그 밖) · 다시 시도 한 번에 등록은 한 번 · 성공하면 조용히 사라짐.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PushRegisterNotice } from './push-register-notice';
import { PUSH_REGISTER_EVENT } from '@/lib/native-shell-bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let post: ReturnType<typeof vi.fn>;

function mount(locale: 'ko' | 'en' = 'ko') {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <PushRegisterNotice />
      </NextIntlClientProvider>,
    );
  });
}
function setShell(pushRegister: unknown, inApp = true) {
  if (inApp) window.ReactNativeWebView = { postMessage: post as unknown as (m: string) => void };
  else delete window.ReactNativeWebView;
  window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister };
}
function shellChanges(pushRegister: unknown) {
  act(() => {
    window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister };
    window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT));
  });
}
const FAILED = { state: 'failed', stage: 'device_token', cause: 'other', retried: false };
const text = () => container.textContent ?? '';
const button = () => container.querySelector('button') as HTMLButtonElement | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  post = vi.fn();
});
afterEach(() => {
  act(() => { window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT)); }); // ends any «registering…» the test left (module state)
  act(() => root.unmount());
  container.remove();
  delete window.__SPRINTABLE_SHELL__;
  delete window.ReactNativeWebView;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PushRegisterNotice — drawn only when the phone says it failed', () => {
  it('in a browser (no native shell) nothing is drawn, even with a forged state', () => {
    setShell(FAILED, false);
    mount();
    expect(container.querySelector('[data-testid="push-register-notice"]')).toBeNull();
  });

  it('registration fine (state ok) or no state → nothing', () => {
    setShell({ state: 'ok' });
    mount();
    expect(container.innerHTML).toBe('');
    act(() => root.unmount());
    root = createRoot(container);
    setShell(undefined);
    mount();
    expect(container.innerHTML).toBe('');
  });

  it('general cause → the general line, role=status (polite, not alert), the outline retry button; never both lines', () => {
    setShell(FAILED);
    mount();
    expect(text()).toContain(koMessages.settings.pushRegisterFailed);
    expect(text()).not.toContain(koMessages.settings.pushRegisterOff);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button()?.textContent).toBe(koMessages.common.retry);
    // quiet outline button, normal text colour — not red and not the primary (the section's own primary, if any, stays the primary)
    expect(button()!.className).toContain('border-border');
    expect(button()!.className).toContain('min-h-11'); // default size = 44px touch target (the line's only action; shown only in the phone app)
    expect(button()!.className).not.toContain('h-7');
    expect(button()!.className).not.toContain('bg-primary');
    expect(container.querySelector('p')!.className).toContain('text-foreground');
    expect(button()!.className).not.toContain('bg-destructive-tint');
    expect(container.firstElementChild!.className).not.toMatch(/destructive|red/); // the block itself is not red
  });

  it('permission cause → the «off» line only', () => {
    setShell({ ...FAILED, stage: 'permission', cause: 'permission' });
    mount();
    expect(text()).toContain(koMessages.settings.pushRegisterOff);
    expect(text()).not.toContain(koMessages.settings.pushRegisterFailed);
    expect(button()?.textContent).toBe(koMessages.common.retry); // the permission line has the button too (back from the phone's settings)
  });

  it('English words too', () => {
    setShell(FAILED);
    mount('en');
    expect(text()).toContain(enMessages.settings.pushRegisterFailed);
    expect(button()?.textContent).toBe(enMessages.common.retry);
  });
});

describe('the sentence added after a failed retry (general cause only)', () => {
  it('the support tab name is read from the messages by its key (a renamed tab reaches this sentence)', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED', 'true');
    setShell({ ...FAILED, retried: true });
    const renamed = { ...koMessages, settings: { ...koMessages.settings, tabSupport: '도움 받기' } };
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={renamed} timeZone="Asia/Seoul">
          <PushRegisterNotice />
        </NextIntlClientProvider>,
      );
    });
    expect(text()).toContain('«도움 받기»');
    expect(text()).not.toContain('«문의·고객지원»');
  });

  it('«으로/로» follows the tab name: a name without a final consonant gets «로» (not a fixed «으로»); the current name keeps «으로»', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED', 'true');
    setShell({ ...FAILED, retried: true });
    const mountWith = (name: string) => {
      act(() => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={{ ...koMessages, settings: { ...koMessages.settings, tabSupport: name } }} timeZone="Asia/Seoul">
            <PushRegisterNotice />
          </NextIntlClientProvider>,
        );
      });
    };
    mountWith('도우미'); // ends in a vowel
    expect(text()).toContain('«도우미»로 알려 주세요');
    expect(text()).not.toContain('«도우미»으로');
    mountWith('문의·고객지원'); // the real name (ends in ㄴ... 원)
    expect(text()).toContain('«문의·고객지원»으로 알려 주세요');
    mountWith('도움말'); // ends in ㄹ → «로»
    expect(text()).toContain('«도움말»로 알려 주세요');
  });

  it('first display: no added sentence', () => {
    setShell(FAILED);
    mount();
    expect(text()).not.toContain('앱을 완전히 닫았다가');
  });

  it('general cause after a failed retry adds the sentences once — and names the support tab BY ITS KEY — where the support tab exists', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED', 'true');
    setShell({ ...FAILED, retried: true });
    mount();
    const contact = koMessages.settings.pushRegisterContactSupport.replace('{support}', koMessages.settings.tabSupport).replace('{josa}', '으로'); // «문의·고객지원» ends in a consonant → «으로»
    expect(text()).toContain(koMessages.settings.pushRegisterStillFailed);
    expect(text()).toContain(contact);
    expect(text().split('앱을 완전히 닫았다가').length - 1).toBe(1);
    expect(text()).toContain(koMessages.settings.pushRegisterFailed); // the first line stays; the sentence goes under it
  });

  it('where the support tab does NOT exist (production has the widget off) the contact sentence is not shown — never point at a missing tab', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED', 'false');
    setShell({ ...FAILED, retried: true });
    mount();
    expect(text()).toContain(koMessages.settings.pushRegisterStillFailed); // the restart sentence still helps
    expect(text()).not.toContain('문의');
    expect(text()).not.toContain(koMessages.settings.tabSupport);
  });

  it('permission cause after a failed retry adds nothing (its line already says what to do)', () => {
    setShell({ ...FAILED, stage: 'permission', cause: 'permission', retried: true });
    mount();
    expect(text()).not.toContain('앱을 완전히 닫았다가');
  });
});

describe('retry button — one registration per press, busy until the shell answers', () => {
  it('a press posts exactly one push-retry; the button reads «등록하는 중이에요…» and is off; a second press does nothing', () => {
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(post.mock.calls[0][0] as string)).toEqual({ type: 'push-retry' });
    expect(button()!.textContent).toBe(koMessages.settings.pushRegisterBusy);
    expect(button()!.disabled).toBe(true);
    act(() => button()!.click());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('two presses in the same tick (before React re-renders the button off) still post once', () => {
    setShell(FAILED);
    mount();
    const b = button()!;
    act(() => { b.click(); b.click(); });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('the shell\'s answer ends busy — a failed retry keeps the line (now with the added sentence), a success removes it with no confirmation text', () => {
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    shellChanges({ ...FAILED, retried: true });
    expect(button()!.disabled).toBe(false);
    expect(button()!.textContent).toBe(koMessages.common.retry);
    expect(text()).toContain('앱을 완전히 닫았다가');
    act(() => button()!.click());
    shellChanges({ state: 'ok' });
    expect(container.querySelector('[data-testid="push-register-notice"]')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('even an unchanged answer (the same failure) ends busy — the shell fires the event after every attempt', () => {
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    shellChanges(FAILED);
    expect(button()!.disabled).toBe(false);
  });

  it('if the shell never answers, the button does not stay off for ever', () => {
    vi.useFakeTimers();
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    expect(button()!.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(button()!.disabled).toBe(false);
  });

  it('switching Settings tabs (the panel unmounts) during a retry keeps «registering…» when the panel comes back — and still posts once', () => {
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    expect(button()!.textContent).toBe(koMessages.settings.pushRegisterBusy);
    expect(button()!.disabled).toBe(true);
    act(() => button()!.click());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('the shell\'s answer while the panel is unmounted still ends «registering…» for when it returns', () => {
    setShell(FAILED);
    mount();
    act(() => button()!.click());
    act(() => root.unmount());
    window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister: { ...FAILED, retried: true } };
    window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT));
    root = createRoot(container);
    mount();
    expect(button()!.disabled).toBe(false);
    expect(text()).toContain('앱을 완전히 닫았다가');
  });

  it('a bridge without a callable postMessage does not throw and does not leave the button off', () => {
    window.ReactNativeWebView = {} as never;
    window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister: FAILED };
    mount();
    expect(() => act(() => button()!.click())).not.toThrow();
    expect(button()!.disabled).toBe(false);
  });
});

describe('words and place', () => {
  const ALL = [koMessages.settings, enMessages.settings].flatMap((s) => [s.pushRegisterOff, s.pushRegisterFailed, s.pushRegisterBusy, s.pushRegisterStillFailed, s.pushRegisterContactSupport]);
  it('no «푸시» / «토큰» / error-code names in any of the words (the product has no such word on screen)', () => {
    for (const w of ALL) expect(w).not.toMatch(/푸시|토큰|token|push|E_REGISTRATION|E_[A-Z_]{4,}/i);
  });

  it('the settings page draws it inside the notifications tab (a revert of the page wiring fails here)', () => {
    const src = readFileSync(join(__dirname, '../../app/(authenticated)/settings/page.tsx'), 'utf8');
    const tab = src.slice(src.indexOf('<TabsContent value="notifications">'));
    expect(tab.slice(0, 1500)).toContain('<PushRegisterNotice />');
    expect(src).toContain("from '@/components/settings/push-register-notice'");
  });
});
