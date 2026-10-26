// @vitest-environment jsdom
/** story 4766 AC5 — the session ends on the onboarding: one line + [다시 로그인] (the dashboard shell's dialog does not reach this page). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { resetSessionExpired, signalSessionExpired } from '@/lib/auth/session-expired-signal';
import { OnboardingSessionExpiredNotice } from './onboarding-session-expired-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realLocation = window.location;

beforeEach(async () => {
  resetSessionExpired();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OnboardingSessionExpiredNotice /></NextIntlClientProvider>);
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true });
  resetSessionExpired();
});

describe('OnboardingSessionExpiredNotice (story 4766 AC5)', () => {
  it('draws nothing while the session lives', () => {
    expect(container.querySelector('[data-testid="onboarding-session-expired"]')).toBeNull();
  });

  it('when the session ends: one line that says so, an alert, and [다시 로그인] — the page under it stays', async () => {
    await act(async () => { signalSessionExpired(); });
    const notice = container.querySelector('[data-testid="onboarding-session-expired"]');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain(koMessages.onboarding.sessionExpired);
    expect(notice?.textContent).toContain(koMessages.onboarding.sessionExpiredCta);
    expect(document.querySelector('[role="dialog"]')).toBeNull(); // not a modal: nothing is taken away
  });

  it('[다시 로그인] goes to the sign-in with THIS address as `next` (so the person lands on the same onboarding page)', async () => {
    Object.defineProperty(window, 'location', { value: { pathname: '/onboarding', search: '?step=project&orgId=org-1', href: '' }, configurable: true, writable: true });
    await act(async () => { signalSessionExpired(); });
    await act(async () => { (container.querySelector('[data-testid="onboarding-session-expired-relogin"]') as HTMLElement).click(); });
    expect(window.location.href).toBe(`/login?next=${encodeURIComponent('/onboarding?step=project&orgId=org-1')}&reason=session_expired`);
  });
});
